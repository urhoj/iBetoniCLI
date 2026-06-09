import { writeJson, exitWithError } from "../../output/json.js";
import { assertWritableEndpoint } from "../../api/endpointGuard.js";
import { CACHE_ENTITIES } from "./entities.js";
// Shared request shaping for the three destructive verbs:
// - preview (no --confirm): dry-run → X-Dry-Run header + { read: true } so it is
//   allowed under --read-only and skips the endpoint guard.
// - execute (--confirm): real write → enforce the shared-cache endpoint guard.
function writeRequestOptions(client, opts) {
    const dryRun = !opts.confirm;
    if (!dryRun)
        assertWritableEndpoint(client.endpoint, opts.forceProd);
    const headers = {};
    if (dryRun)
        headers["X-Dry-Run"] = "1";
    if (opts.reason)
        headers["X-Action-Reason"] = opts.reason;
    return { dryRun, fetchOpts: dryRun ? { headers, read: true } : { headers } };
}
export async function runCacheStats(client) {
    return client.get("/api/cli/cache/stats");
}
export async function runCacheKeys(client, opts) {
    const qs = opts.pattern ? `?pattern=${encodeURIComponent(opts.pattern)}` : "";
    return client.get(`/api/cli/cache/keys${qs}`);
}
export async function runCacheInvalidate(client, body, opts) {
    const { fetchOpts } = writeRequestOptions(client, opts);
    const payload = { entityType: body.entityType, cascade: !!body.cascade };
    if (body.id !== undefined)
        payload.id = body.id;
    if (body.asiakasId !== undefined)
        payload.asiakasId = body.asiakasId;
    return client.post("/api/cli/cache/invalidate", payload, fetchOpts);
}
export async function runCacheClear(client, opts) {
    const { dryRun, fetchOpts } = writeRequestOptions(client, opts);
    return client.post("/api/cli/cache/clear", { confirmed: !dryRun }, fetchOpts);
}
export async function runCachePattern(client, pattern, opts) {
    const { dryRun, fetchOpts } = writeRequestOptions(client, opts);
    return client.post("/api/cli/cache/pattern", { pattern, confirmed: !dryRun }, fetchOpts);
}
/**
 * Register `ib cache` subcommands. Inspect verbs (stats/keys) are GETs and
 * developer-gated server-side. Destructive verbs (invalidate/clear/pattern)
 * preview by default and require --confirm to execute; --force-prod overrides
 * the shared-cache endpoint guard. `entities` is fully offline.
 */
export function registerCacheCommands(parent, getClient) {
    const c = parent.command("cache").description("Redis cache inspection and invalidation (admin/developer)");
    c.command("stats")
        .description("Cache connection, key count, and hit rate (developer-only)")
        .action(async () => {
        try {
            writeJson(await runCacheStats(await getClient()));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("keys")
        .description("Key counts grouped by prefix (developer-only)")
        .option("--pattern <glob>", "SCAN match pattern", "*")
        .action(async (opts) => {
        try {
            writeJson(await runCacheKeys(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("invalidate <entityType>")
        .description("Invalidate one entity family by domain identifier. Previews unless --confirm.")
        .option("--id <n>", "Entity id (e.g. keikkaId)", (v) => Number(v))
        .option("--asiakas-id <n>", "Tenant scope (developers only; non-devs use their own)", (v) => Number(v))
        .option("--cascade", "Also invalidate related families (keikka only)")
        .option("--confirm", "Execute the invalidation (default is dry-run preview)")
        .option("--force-prod", "Allow execution against a deployed (shared-cache) endpoint")
        .option("--reason <text>", "Audit reason (X-Action-Reason)")
        .action(async (entityType, opts) => {
        try {
            writeJson(await runCacheInvalidate(await getClient(), { entityType, id: opts.id, asiakasId: opts.asiakasId, cascade: opts.cascade }, { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("clear")
        .description("Flush the entire cache (developer-only). Previews unless --confirm.")
        .option("--confirm", "Execute the full flush (default is dry-run preview)")
        .option("--force-prod", "Allow execution against a deployed (shared-cache) endpoint")
        .option("--reason <text>", "Audit reason (X-Action-Reason)")
        .action(async (opts) => {
        try {
            writeJson(await runCacheClear(await getClient(), { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("pattern <glob>")
        .description("Invalidate keys matching a raw glob (developer-only). Previews unless --confirm.")
        .option("--confirm", "Execute the invalidation (default is dry-run preview)")
        .option("--force-prod", "Allow execution against a deployed (shared-cache) endpoint")
        .option("--reason <text>", "Audit reason (X-Action-Reason)")
        .action(async (glob, opts) => {
        try {
            writeJson(await runCachePattern(await getClient(), glob, { confirm: !!opts.confirm, forceProd: !!opts.forceProd, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("entities")
        .description("List the valid cache entity types and their parameters (offline)")
        .action(() => {
        writeJson({ items: CACHE_ENTITIES, count: CACHE_ENTITIES.length });
    });
}
//# sourceMappingURL=index.js.map