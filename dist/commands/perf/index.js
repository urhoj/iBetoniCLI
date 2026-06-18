import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { writeJson, exitWithError } from "../../output/json.js";
function envQuery(env) {
    return env ? `?env=${encodeURIComponent(env)}` : "";
}
/** GET recent slow queries → ListEnvelope. `truncated` when the page filled the limit. */
export async function runPerfSlow(client, opts) {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined)
        qs.set("limit", String(opts.limit));
    if (opts.env)
        qs.set("env", opts.env);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await client.get(`/api/admin/slow-queries${suffix}`);
    const d = res.data ?? {};
    const items = (d.queries ?? []).map((r) => ({
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
export async function runPerfStats(client, opts) {
    const res = await client.get(`/api/admin/slow-queries/stats${envQuery(opts.env)}`);
    return res.data;
}
/** GET collector config + the list of environments that have data. */
export async function runPerfConfig(client) {
    const [cfg, envs] = await Promise.all([
        client.get(`/api/admin/slow-queries/config`),
        client.get(`/api/admin/slow-queries/environments`),
    ]);
    return { ...(cfg.data ?? {}), availableEnvironments: envs.data ?? [] };
}
/** DELETE the buffer. --dry-run resolves CLIENT-SIDE (the route honours no X-Dry-Run). */
export async function runPerfClear(client, opts) {
    const path = `/api/admin/slow-queries${envQuery(opts.env)}`;
    if (opts.dryRun) {
        return { dryRun: true, wouldClear: { method: "DELETE", path } };
    }
    const headers = writeFlagsToHeaders({
        reason: opts.reason,
        idempotencyKey: opts.idempotencyKey,
    });
    const res = await client.delete(path, { headers });
    return { cleared: true, environment: opts.env ?? null, message: res.message ?? "cleared" };
}
export function registerPerfCommands(parent, getClient) {
    const perf = parent.command("perf").description("SQL slow-query monitoring (developer)");
    perf
        .command("slow")
        .description("Recent slow queries from the collector's ring buffer")
        .option("--limit <n>", "Max rows (default 50)", (v) => Number(v))
        .option("--env <name>", "Environment buffer to read (default: backend's current env)")
        .action(async (opts) => {
        try {
            writeJson(await runPerfSlow(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    perf
        .command("stats")
        .description("Aggregate slow-query stats: top procedures, avg/max, by-entity")
        .option("--env <name>", "Environment buffer to read (default: backend's current env)")
        .action(async (opts) => {
        try {
            writeJson(await runPerfStats(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    perf
        .command("config")
        .description("Collector thresholds + available environments")
        .action(async () => {
        try {
            writeJson(await runPerfConfig(await getClient()));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const clear = perf
        .command("clear")
        .description("Clear the slow-query buffer for one environment (developer write)")
        .option("--env <name>", "Environment buffer to clear (default: backend's current env)");
    addWriteFlagsToCommand(clear).action(async (opts) => {
        try {
            writeJson(await runPerfClear(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map