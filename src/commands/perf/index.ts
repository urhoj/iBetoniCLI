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
import type { ListEnvelope } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { writeJson, exitWithError } from "../../output/json.js";

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

/** Build a `?k=v&...` query suffix from defined params (one idiom for all reads). */
function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
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
    items,
    nextCursor: null,
    count: items.length,
    truncated: items.length >= limit,
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
  const [cfg, envs] = await Promise.all([
    client.get<{ data: Record<string, unknown> }>(`/api/admin/slow-queries/config`),
    client.get<{ data: string[] }>(`/api/admin/slow-queries/environments`),
  ]);
  return { ...(cfg.data ?? {}), availableEnvironments: envs.data ?? [] };
}

/** DELETE the buffer. --dry-run resolves CLIENT-SIDE (the route honours no X-Dry-Run). */
export async function runPerfClear(
  client: ApiClient,
  opts: { env?: string; reason?: string; idempotencyKey?: string; dryRun?: boolean }
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
    .description("Recent slow queries from the collector's ring buffer")
    .option("--limit <n>", "Max rows (default 50)", (v: string) => Number(v))
    .option("--env <name>", "Environment buffer to read (default: backend's current env)")
    .action(async (opts: { limit?: number; env?: string }) => {
      try {
        writeJson(await runPerfSlow(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  perf
    .command("stats")
    .description("Aggregate slow-query stats: top procedures, avg/max, by-entity")
    .option("--env <name>", "Environment buffer to read (default: backend's current env)")
    .action(async (opts: { env?: string }) => {
      try {
        writeJson(await runPerfStats(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  perf
    .command("config")
    .description("Collector thresholds + available environments")
    .action(async () => {
      try {
        writeJson(await runPerfConfig(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  const clear = perf
    .command("clear")
    .description("Clear the slow-query buffer for one environment (developer write)")
    .option("--env <name>", "Environment buffer to clear (default: backend's current env)");
  addWriteFlagsToCommand(clear).action(
    async (opts: { env?: string; reason?: string; idempotencyKey?: string; dryRun?: boolean }) => {
      try {
        writeJson(await runPerfClear(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
