/**
 * Per-invocation timing accumulator for the global `--stats` flag.
 *
 * A process singleton (fan-out commands mint multiple clients but share one
 * stats line). The API client feeds `recordRequest` per request; `bin/ib.ts`
 * (and runArgv, if wired) calls `flushStats` once after the command resolves.
 * Output is one stderr line — never stdout (preserves the JSON data contract).
 * SQL time and cache hit/miss counts cover the executeQuery (cache-runner) path
 * only and are always labelled as such.
 */
interface StatsAccumulator {
  enabled: boolean;
  apiMs: number;
  apiReqCount: number;
  sqlMs: number;
  sqlProcCount: number;
  sqlSeen: boolean;
  cacheHits: number;
  cacheMisses: number;
  cacheSeen: boolean;
}

function empty(): StatsAccumulator {
  return {
    enabled: false,
    apiMs: 0,
    apiReqCount: 0,
    sqlMs: 0,
    sqlProcCount: 0,
    sqlSeen: false,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSeen: false,
  };
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

interface ParsedTiming {
  sqlMs?: number;
  sqlProcCount?: number;
  cacheHits?: number;
  cacheMisses?: number;
}

/**
 * Parse a `Server-Timing` header for the backend's `sql` / `cacheHit` /
 * `cacheMiss` metrics. Best-effort, never throws. Encoding (set by puminet5api
 * `app.js`): `sql;dur=<ms>;desc="<n> procs", cacheHit;dur=<n>, cacheMiss;dur=<n>`
 * — counts ride in `dur` for trivial numeric parsing.
 */
export function parseServerTiming(header: string | null): ParsedTiming {
  if (!header) return {};
  const out: ParsedTiming = {};
  for (const part of header.split(",")) {
    const segs = part.split(";").map((s) => s.trim());
    const name = segs[0];
    if (name !== "sql" && name !== "cacheHit" && name !== "cacheMiss") continue;
    let dur: number | undefined;
    let procCount: number | undefined;
    for (const seg of segs.slice(1)) {
      const durMatch = /^dur=([0-9.]+)$/.exec(seg);
      if (durMatch) dur = Number(durMatch[1]);
      const descMatch = /^desc="?(\d+) procs"?$/.exec(seg);
      if (descMatch) procCount = Number(descMatch[1]);
    }
    if (name === "sql") {
      if (dur !== undefined) out.sqlMs = dur;
      if (procCount !== undefined) out.sqlProcCount = procCount;
    } else if (name === "cacheHit") {
      if (dur !== undefined) out.cacheHits = dur;
    } else if (name === "cacheMiss") {
      if (dur !== undefined) out.cacheMisses = dur;
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
  if (t.cacheHits !== undefined || t.cacheMisses !== undefined) {
    acc.cacheHits += t.cacheHits ?? 0;
    acc.cacheMisses += t.cacheMisses ?? 0;
    acc.cacheSeen = true;
  }
}

/** Build the stderr stats line, or null when disabled / no requests were made. */
export function buildStatsLine(pretty: boolean): string | null {
  if (!acc.enabled || acc.apiReqCount === 0) return null;
  if (pretty) {
    const reqPart = acc.apiReqCount > 1 ? ` over ${acc.apiReqCount} requests` : "";
    const sqlPart = acc.sqlSeen
      ? ` sql=${acc.sqlMs}ms (${acc.sqlProcCount} procs, executeQuery-path-only)`
      : "";
    const cachePart = acc.cacheSeen ? ` cache=${acc.cacheHits} hit / ${acc.cacheMisses} miss` : "";
    return `[ib] stats: api=${acc.apiMs}ms${reqPart}${sqlPart}${cachePart}`;
  }
  const stats: Record<string, unknown> = { apiMs: acc.apiMs };
  if (acc.apiReqCount > 1) stats.apiReqCount = acc.apiReqCount;
  if (acc.sqlSeen) {
    stats.sqlMs = acc.sqlMs;
    stats.sqlProcCount = acc.sqlProcCount;
    stats.sqlCoverage = "executeQuery-path-only";
  }
  if (acc.cacheSeen) {
    stats.cacheHits = acc.cacheHits;
    stats.cacheMisses = acc.cacheMisses;
  }
  return JSON.stringify({ stats });
}

export function flushStats(opts: { pretty: boolean }): void {
  const line = buildStatsLine(opts.pretty);
  if (line) process.stderr.write(line + "\n");
}
