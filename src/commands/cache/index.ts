import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { assertWritableEndpoint } from "../../api/endpointGuard.js";
import { CACHE_ENTITIES } from "./entities.js";

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
export function registerCacheCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  const c = parent.command("cache").description("Redis cache inspection and invalidation (admin/developer)");

  c.command("stats")
    .description("Cache connection, key count, and hit rate (developer-only)")
    .action(async () => {
      try {
        writeJson(await runCacheStats(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("keys")
    .description("Key counts grouped by prefix (developer-only)")
    .option("--pattern <glob>", "SCAN match pattern", "*")
    .action(async (opts: { pattern?: string }) => {
      try {
        writeJson(await runCacheKeys(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("invalidate <entityType>")
    .description("Invalidate one entity family by domain identifier. Previews unless --confirm.")
    .option("--id <n>", "Entity id (e.g. keikkaId)", (v: string) => Number(v))
    .option("--asiakas-id <n>", "Tenant scope (developers only; non-devs use their own)", (v: string) => Number(v))
    .option("--cascade", "Also invalidate related families (keikka only)")
    .option("--confirm", "Execute the invalidation (default is dry-run preview)")
    .option("--force-prod", "Allow execution against a deployed (shared-cache) endpoint")
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .action(async (entityType: string, opts: { id?: number; asiakasId?: number; cascade?: boolean; confirm?: boolean; forceProd?: boolean; reason?: string }) => {
      try {
        writeJson(
          await runCacheInvalidate(
            await getClient(),
            { entityType, id: opts.id, asiakasId: opts.asiakasId, cascade: opts.cascade },
            { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("clear")
    .description("Flush the entire cache (developer-only). Previews unless --confirm.")
    .option("--confirm", "Execute the full flush (default is dry-run preview)")
    .option("--force-prod", "Allow execution against a deployed (shared-cache) endpoint")
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .action(async (opts: { confirm?: boolean; forceProd?: boolean; reason?: string }) => {
      try {
        writeJson(await runCacheClear(await getClient(), { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("pattern <glob>")
    .description("Invalidate keys matching a raw glob (developer-only). Previews unless --confirm.")
    .option("--confirm", "Execute the invalidation (default is dry-run preview)")
    .option("--force-prod", "Allow execution against a deployed (shared-cache) endpoint")
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .action(async (glob: string, opts: { confirm?: boolean; forceProd?: boolean; reason?: string }) => {
      try {
        writeJson(await runCachePattern(await getClient(), glob, { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("entities")
    .description("List the valid cache entity types and their parameters (offline)")
    .action(() => {
      writeJson({ items: CACHE_ENTITIES, count: CACHE_ENTITIES.length });
    });
}
