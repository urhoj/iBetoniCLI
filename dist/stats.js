function empty() {
    return { enabled: false, apiMs: 0, apiReqCount: 0, sqlMs: 0, sqlProcCount: 0, sqlSeen: false };
}
let acc = empty();
export function enableStats() {
    acc.enabled = true;
}
export function statsEnabled() {
    return acc.enabled;
}
export function resetStats() {
    acc = empty();
}
/** Parse a `Server-Timing` header for the `sql` metric. Best-effort, never throws. */
export function parseServerTiming(header) {
    if (!header)
        return {};
    const out = {};
    // Metrics are comma-separated; find the `sql` one.
    for (const part of header.split(",")) {
        const segs = part.split(";").map((s) => s.trim());
        if (segs[0] !== "sql")
            continue;
        for (const seg of segs.slice(1)) {
            const durMatch = /^dur=([0-9.]+)$/.exec(seg);
            if (durMatch)
                out.sqlMs = Number(durMatch[1]);
            const descMatch = /^desc="?(\d+) procs"?$/.exec(seg);
            if (descMatch)
                out.sqlProcCount = Number(descMatch[1]);
        }
    }
    return out;
}
export function recordRequest(info) {
    if (!acc.enabled)
        return;
    acc.apiMs += info.apiMs;
    acc.apiReqCount += 1;
    const t = parseServerTiming(info.serverTiming);
    if (t.sqlMs !== undefined) {
        acc.sqlMs += t.sqlMs;
        acc.sqlSeen = true;
    }
    if (t.sqlProcCount !== undefined)
        acc.sqlProcCount += t.sqlProcCount;
}
/** Build the stderr stats line, or null when disabled / no requests were made. */
export function buildStatsLine(pretty) {
    if (!acc.enabled || acc.apiReqCount === 0)
        return null;
    if (pretty) {
        const reqPart = acc.apiReqCount > 1 ? ` over ${acc.apiReqCount} requests` : "";
        const sqlPart = acc.sqlSeen
            ? ` sql=${acc.sqlMs}ms (${acc.sqlProcCount} procs, executeQuery-path-only)`
            : "";
        return `[ib] stats: api=${acc.apiMs}ms${reqPart}${sqlPart}`;
    }
    const stats = { apiMs: acc.apiMs };
    if (acc.apiReqCount > 1)
        stats.apiReqCount = acc.apiReqCount;
    if (acc.sqlSeen) {
        stats.sqlMs = acc.sqlMs;
        stats.sqlProcCount = acc.sqlProcCount;
        stats.sqlCoverage = "executeQuery-path-only";
    }
    return JSON.stringify({ stats });
}
export function flushStats(opts) {
    const line = buildStatsLine(opts.pretty);
    if (line)
        process.stderr.write(line + "\n");
}
//# sourceMappingURL=stats.js.map