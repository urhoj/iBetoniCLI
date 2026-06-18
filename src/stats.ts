/**
 * Per-invocation timing accumulator for the global `--stats` flag.
 *
 * A process singleton (fan-out commands mint multiple clients but share one
 * stats line). The API client feeds `recordRequest` per request; `bin/ib.ts`
 * (and runArgv, if wired) calls `flushStats` once after the command resolves.
 * Output is one stderr line — never stdout (preserves the JSON data contract).
 * SQL coverage is executeQuery-path-only and always labelled as such.
 */
interface StatsAccumulator {
  enabled: boolean;
  apiMs: number;
  apiReqCount: number;
  sqlMs: number;
  sqlProcCount: number;
  sqlSeen: boolean;
}

function empty(): StatsAccumulator {
  return { enabled: false, apiMs: 0, apiReqCount: 0, sqlMs: 0, sqlProcCount: 0, sqlSeen: false };
}

let acc: StatsAccumulator = empty();

export function enableStats(): void {
  acc.enabled = true;
}
export function statsEnabled(): boolean {
  return acc.enabled;
}
export function resetStats(): void {
  acc = empty();
}

/** Parse a `Server-Timing` header for the `sql` metric. Best-effort, never throws. */
export function parseServerTiming(header: string | null): { sqlMs?: number; sqlProcCount?: number } {
  if (!header) return {};
  const out: { sqlMs?: number; sqlProcCount?: number } = {};
  // Metrics are comma-separated; find the `sql` one.
  for (const part of header.split(",")) {
    const segs = part.split(";").map((s) => s.trim());
    if (segs[0] !== "sql") continue;
    for (const seg of segs.slice(1)) {
      const durMatch = /^dur=([0-9.]+)$/.exec(seg);
      if (durMatch) out.sqlMs = Number(durMatch[1]);
      const descMatch = /^desc="?(\d+) procs"?$/.exec(seg);
      if (descMatch) out.sqlProcCount = Number(descMatch[1]);
    }
  }
  return out;
}

export function recordRequest(info: { apiMs: number; serverTiming: string | null }): void {
  if (!acc.enabled) return;
  acc.apiMs += info.apiMs;
  acc.apiReqCount += 1;
  const t = parseServerTiming(info.serverTiming);
  if (t.sqlMs !== undefined) {
    acc.sqlMs += t.sqlMs;
    acc.sqlSeen = true;
  }
  if (t.sqlProcCount !== undefined) acc.sqlProcCount += t.sqlProcCount;
}

/** Build the stderr stats line, or null when disabled / no requests were made. */
export function buildStatsLine(pretty: boolean): string | null {
  if (!acc.enabled || acc.apiReqCount === 0) return null;
  if (pretty) {
    const reqPart = acc.apiReqCount > 1 ? ` over ${acc.apiReqCount} requests` : "";
    const sqlPart = acc.sqlSeen
      ? ` sql=${acc.sqlMs}ms (${acc.sqlProcCount} procs, executeQuery-path-only)`
      : "";
    return `[ib] stats: api=${acc.apiMs}ms${reqPart}${sqlPart}`;
  }
  const stats: Record<string, unknown> = { apiMs: acc.apiMs };
  if (acc.apiReqCount > 1) stats.apiReqCount = acc.apiReqCount;
  if (acc.sqlSeen) {
    stats.sqlMs = acc.sqlMs;
    stats.sqlProcCount = acc.sqlProcCount;
    stats.sqlCoverage = "executeQuery-path-only";
  }
  return JSON.stringify({ stats });
}

export function flushStats(opts: { pretty: boolean }): void {
  const line = buildStatsLine(opts.pretty);
  if (line) process.stderr.write(line + "\n");
}
