/**
 * `ib perf` — surface the backend's slow-query collector (Redis ring buffer)
 * over the existing /api/admin/slow-queries* routes. Read commands work under
 * --read-only; `clear` is a developer write. All four are tier:"developer".
 *
 * SQL coverage is executeQuery-path-only (raw getConnection() queries are not
 * timed) — the same caveat the global --stats flag carries.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { qs } from "../../api/query.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { jsonAction } from "../_shared/action.js";
import { bothInOrder } from "../../parallel.js";

interface RawSlow {
  procedure: string;
  duration: number;
  entity: string;
  params?: string[];
  timestamp: string;
}
interface SlowQueryRow {
  procedure: string;
  durationMs: number;
  entity: string;
  params: string[];
  timestamp: string;
}

/** GET recent slow queries → ListEnvelope. `truncated` when the page filled the limit. */
export async function runPerfSlow(
  client: ApiClient,
  opts: { limit?: number; env?: string }
): Promise<ListEnvelope<SlowQueryRow> & { totalCount?: number; environment?: string }> {
  const res = await client.get<{
    data: { queries?: RawSlow[]; totalCount?: number; environment?: string };
  }>(`/api/admin/slow-queries${qs({ limit: opts.limit, env: opts.env })}`);
  const d = res.data ?? {};
  const items: SlowQueryRow[] = (d.queries ?? []).map((r) => ({
    procedure: r.procedure,
    durationMs: r.duration,
    entity: r.entity,
    params: r.params ?? [],
    timestamp: r.timestamp,
  }));
  const limit = opts.limit ?? 50;
  return {
    ...listEnvelope(items, { truncated: items.length >= limit }),
    totalCount: d.totalCount,
    environment: d.environment,
  };
}

/** GET aggregate slow-query stats (top procedures, avg/max, by-entity). */
export async function runPerfStats(client: ApiClient, opts: { env?: string }): Promise<unknown> {
  const res = await client.get<{ data: unknown }>(
    `/api/admin/slow-queries/stats${qs({ env: opts.env })}`
  );
  return res.data;
}

/** GET collector config + the list of environments that have data. */
export async function runPerfConfig(client: ApiClient): Promise<Record<string, unknown>> {
  const [cfg, envs] = await bothInOrder(
    client.get<{ data: Record<string, unknown> }>(`/api/admin/slow-queries/config`),
    client.get<{ data: string[] }>(`/api/admin/slow-queries/environments`)
  );
  return { ...(cfg.data ?? {}), availableEnvironments: envs.data ?? [] };
}

/** DELETE the buffer. --dry-run resolves CLIENT-SIDE (the route honours no X-Dry-Run). */
export async function runPerfClear(
  client: ApiClient,
  opts: WriteFlags & { env?: string }
): Promise<unknown> {
  const path = `/api/admin/slow-queries${qs({ env: opts.env })}`;
  if (opts.dryRun) {
    return { dryRun: true, wouldClear: { method: "DELETE", path } };
  }
  const headers = writeFlagsToHeaders({
    reason: opts.reason,
    idempotencyKey: opts.idempotencyKey,
  });
  const res = await client.delete<{ message?: string }>(path, { headers });
  return { cleared: true, environment: opts.env ?? null, message: res.message ?? "cleared" };
}

export function registerPerfCommands(parent: Command, getClient: () => Promise<ApiClient>, opts: { hidden?: boolean } = {}): void {
  const perf = parent.command("perf", { hidden: !!opts.hidden }).description("SQL slow-query monitoring (developer)");

  perf
    .command("slow")
    .option("--limit <n>", "", (v: string) => Number(v))
    .option("--env <name>")
    .action(
      jsonAction(getClient, (client, opts: { limit?: number; env?: string }) =>
        runPerfSlow(client, opts)
      )
    );

  perf
    .command("stats")
    .option("--env <name>")
    .action(jsonAction(getClient, runPerfStats));

  perf
    .command("config")
    .action(jsonAction(getClient, runPerfConfig));

  const clear = perf
    .command("clear")
    .option("--env <name>");
  addWriteFlagsToCommand(clear).action(
    jsonAction(getClient, (client, opts: WriteFlags & { env?: string }) =>
      runPerfClear(client, opts)
    )
  );
}
