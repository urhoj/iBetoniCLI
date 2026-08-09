import { Option } from "commander";
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson } from "../../output/json.js";
import { assertWritableEndpoint } from "../../api/endpointGuard.js";
import { CACHE_ENTITIES } from "./entities.js";
import { jsonAction, guarded } from "../_shared/action.js";
export interface CacheWriteOpts {
  confirm: boolean;
  forceProd: boolean;
  reason?: string;
}

// Shared request shaping for the three destructive verbs:
// - preview (no --confirm): dry-run → X-Dry-Run header + { read: true } so it is
//   allowed under --read-only and skips the endpoint guard.
// - execute (--confirm): real write → enforce the shared-cache endpoint guard.
// - --force-prod additionally travels as X-Force-Prod: 1 — a deployed backend
//   refuses destructive ops without it (server-side guard; closes the
//   /api/cli/exec + MCP loopback bypass of the client-side endpoint check).
function writeRequestOptions(client: ApiClient, opts: CacheWriteOpts): {
  dryRun: boolean;
  fetchOpts: { headers: Record<string, string>; read?: boolean };
} {
  const dryRun = !opts.confirm;
  if (!dryRun) assertWritableEndpoint(client.endpoint, opts.forceProd);
  const headers: Record<string, string> = {};
  if (dryRun) headers["X-Dry-Run"] = "1";
  if (!dryRun && opts.forceProd) headers["X-Force-Prod"] = "1";
  if (opts.reason) headers["X-Action-Reason"] = opts.reason;
  return { dryRun, fetchOpts: dryRun ? { headers, read: true } : { headers } };
}

export async function runCacheStats(client: ApiClient): Promise<unknown> {
  return client.get("/api/cli/cache/stats");
}

export async function runCacheKeys(client: ApiClient, opts: { pattern?: string }): Promise<unknown> {
  const qs = opts.pattern ? `?pattern=${encodeURIComponent(opts.pattern)}` : "";
  return client.get(`/api/cli/cache/keys${qs}`);
}

export async function runCacheInvalidate(
  client: ApiClient,
  body: { entityType: string; id?: number; asiakasId?: number; cascade?: boolean },
  opts: CacheWriteOpts
): Promise<unknown> {
  const { fetchOpts } = writeRequestOptions(client, opts);
  const payload: Record<string, unknown> = { entityType: body.entityType, cascade: !!body.cascade };
  if (body.id !== undefined) payload.id = body.id;
  if (body.asiakasId !== undefined) payload.asiakasId = body.asiakasId;
  return client.post("/api/cli/cache/invalidate", payload, fetchOpts);
}

export async function runCacheClear(client: ApiClient, opts: CacheWriteOpts): Promise<unknown> {
  const { dryRun, fetchOpts } = writeRequestOptions(client, opts);
  return client.post("/api/cli/cache/clear", { confirmed: !dryRun }, fetchOpts);
}

export async function runCachePattern(
  client: ApiClient,
  pattern: string,
  opts: CacheWriteOpts
): Promise<unknown> {
  const { dryRun, fetchOpts } = writeRequestOptions(client, opts);
  return client.post("/api/cli/cache/pattern", { pattern, confirmed: !dryRun }, fetchOpts);
}

/**
 * Register `ib cache` subcommands. Inspect verbs (stats/keys) are GETs and
 * developer-gated server-side. Destructive verbs (invalidate/clear/pattern)
 * preview by default and require --confirm to execute; --force-prod overrides
 * the shared-cache endpoint guard. `entities` is fully offline.
 */
export function registerCacheCommands(parent: Command, getClient: () => Promise<ApiClient>, opts: { hidden?: boolean } = {}): void {
  const c = parent.command("cache", { hidden: !!opts.hidden }).description("Redis cache inspection and invalidation (admin/developer)");

  c.command("stats")
    .action(jsonAction(getClient, runCacheStats));

  c.command("keys")
    .option("--pattern <glob>", "", "*")
    .action(
      jsonAction(getClient, (client, opts: { pattern?: string }) => runCacheKeys(client, opts))
    );

  c.command("invalidate <entityType>")
    .option("--id <n>", "", (v: string) => Number(v))
    .option("--asiakas <n>", "", (v: string) => Number(v))
    // Back-compat alias for the pre-rename spelling (fb#388). `--asiakas-id` was
    // the lone outlier among 39 tenant-scoped commands — 38 spell it `--asiakas`
    // — so guessing the majority form failed here and guessing this one failed
    // everywhere else. Hidden: the spec documents only `--asiakas`, so `--help`
    // and `reference dump` show one spelling while old scripts keep working.
    .addOption(
      new Option("--asiakas-id <n>").argParser((v: string) => Number(v)).hideHelp()
    )
    .option("--cascade")
    .option("--confirm")
    .option("--force-prod")
    .option("--reason <text>")
    .action(
      jsonAction(getClient, (client, entityType: string, opts: { id?: number; asiakas?: number; asiakasId?: number; cascade?: boolean; confirm?: boolean; forceProd?: boolean; reason?: string }) =>
        runCacheInvalidate(
          client,
          { entityType, id: opts.id, asiakasId: opts.asiakas ?? opts.asiakasId, cascade: opts.cascade },
          { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }
        )
      )
    );

  c.command("clear")
    .option("--confirm")
    .option("--force-prod")
    .option("--reason <text>")
    .action(
      jsonAction(getClient, (client, opts: { confirm?: boolean; forceProd?: boolean; reason?: string }) =>
        runCacheClear(client, { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason })
      )
    );

  c.command("pattern <glob>")
    .option("--confirm")
    .option("--force-prod")
    .option("--reason <text>")
    .action(
      jsonAction(getClient, (client, glob: string, opts: { confirm?: boolean; forceProd?: boolean; reason?: string }) =>
        runCachePattern(client, glob, { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason })
      )
    );

  c.command("entities")
    .action(
      guarded(() => {
        writeJson({ items: CACHE_ENTITIES, count: CACHE_ENTITIES.length });
      })
    );
}
