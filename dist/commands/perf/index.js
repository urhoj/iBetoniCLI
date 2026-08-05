import { qs } from "../../api/query.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
/** GET recent slow queries → ListEnvelope. `truncated` when the page filled the limit. */
export async function runPerfSlow(client, opts) {
    const res = await client.get(`/api/admin/slow-queries${qs({ limit: opts.limit, env: opts.env })}`);
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
    const res = await client.get(`/api/admin/slow-queries/stats${qs({ env: opts.env })}`);
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
    const path = `/api/admin/slow-queries${qs({ env: opts.env })}`;
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
export function registerPerfCommands(parent, getClient, opts = {}) {
    const perf = parent.command("perf", { hidden: !!opts.hidden }).description("SQL slow-query monitoring (developer)");
    perf
        .command("slow")
        .description("Recent slow queries from the collector's ring buffer")
        .option("--limit <n>", "Max rows (default 50)", (v) => Number(v))
        .option("--env <name>", "Environment buffer to read (default: backend's current env)")
        .action(guarded(async (opts) => {
        writeJson(await runPerfSlow(await getClient(), opts));
    }));
    perf
        .command("stats")
        .description("Aggregate slow-query stats: top procedures, avg/max, by-entity")
        .option("--env <name>", "Environment buffer to read (default: backend's current env)")
        .action(guarded(async (opts) => {
        writeJson(await runPerfStats(await getClient(), opts));
    }));
    perf
        .command("config")
        .description("Collector thresholds + available environments")
        .action(guarded(async () => {
        writeJson(await runPerfConfig(await getClient()));
    }));
    const clear = perf
        .command("clear")
        .description("Clear the slow-query buffer for one environment (developer write)")
        .option("--env <name>", "Environment buffer to clear (default: backend's current env)");
    addWriteFlagsToCommand(clear).action(jsonAction(getClient, (client, opts) => runPerfClear(client, opts)));
}
//# sourceMappingURL=index.js.map