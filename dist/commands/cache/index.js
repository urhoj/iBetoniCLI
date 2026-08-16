import { Option } from "commander";
import { writeJson, failWith } from "../../output/json.js";
import { assertWritableEndpoint } from "../../api/endpointGuard.js";
import { CACHE_ENTITIES } from "./entities.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { resolveDualString } from "../../targets.js";
// Shared request shaping for the three destructive verbs:
// - preview (no --confirm): dry-run → X-Dry-Run header + { read: true } so it is
//   allowed under --read-only and skips the endpoint guard.
// - execute (--confirm): real write → enforce the shared-cache endpoint guard.
// - --force-prod additionally travels as X-Force-Prod: 1 — a deployed backend
//   refuses destructive ops without it (server-side guard; closes the
//   /api/cli/exec + MCP loopback bypass of the client-side endpoint check).
function writeRequestOptions(client, opts) {
    // `--dry-run --confirm` states both intentions at once. Silently letting one
    // win is exactly the failure mode this group already had: whichever we picked,
    // half the callers would get the opposite of what they asked for, and on the
    // execute side that means deleted keys. Refuse and make them choose (fb#645).
    if (opts.dryRun && opts.confirm) {
        failWith("--dry-run and --confirm are mutually exclusive: --dry-run previews (the default here) and --confirm executes", 4, "drop --dry-run to execute, or drop --confirm to preview");
    }
    const dryRun = !opts.confirm;
    if (!dryRun)
        assertWritableEndpoint(client.endpoint, opts.forceProd);
    const headers = {};
    if (dryRun)
        headers["X-Dry-Run"] = "1";
    if (!dryRun && opts.forceProd)
        headers["X-Force-Prod"] = "1";
    if (opts.reason)
        headers["X-Action-Reason"] = opts.reason;
    return { dryRun, fetchOpts: dryRun ? { headers, read: true } : { headers } };
}
/**
 * Resolve the SCAN glob for `cache pattern`, which accepts it positionally
 * (canonical) or as `--pattern <glob>` — the sibling `cache keys` spells the very
 * same concept as a flag, so reaching for it here is the natural error (fb#645).
 *
 * Delegates to the shared {@link resolveDualString} rather than re-implementing
 * the exactly-one-required / both-only-if-equal rule, which is what
 * `resolveSearchQuery` already does for `<query>` / `--search`. (Its numeric twin
 * `resolveTarget` is the wrong helper — it coerces to a positive integer, which
 * every glob would fail.)
 */
export function resolveGlob(positional, flag) {
    return resolveDualString(positional, flag, "glob", "pattern", "use `ib dev cache keys --pattern '<glob>'` first to see what a glob matches");
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
/** Flags shared by the three destructive verbs, in one place so adding a fourth
 *  (as fb#645 did with `--dry-run`) cannot reach two call sites and miss the
 *  third. Same shape as `addWriteFlagsToCommand` / `addAsiakasTargetOption`;
 *  registration ORDER is preserved, so `--help` renders as before. */
function addCacheWriteOptions(cmd) {
    return cmd
        .option("--confirm")
        .option("--dry-run")
        .option("--force-prod")
        .option("--reason <text>");
}
/** Commander opts → {@link CacheWriteOpts}. Extra keys on the source (`id`,
 *  `cascade`, `pattern`) are ignored — passing the existing object rather than a
 *  fresh literal keeps TS excess-property checking out of the way. */
function toCacheWriteOpts(opts) {
    return {
        confirm: !!opts.confirm,
        dryRun: !!opts.dryRun,
        forceProd: !!opts.forceProd,
        reason: opts.reason,
    };
}
/**
 * Register `ib cache` subcommands. Inspect verbs (stats/keys) are GETs and
 * developer-gated server-side. Destructive verbs (invalidate/clear/pattern)
 * preview by default and require --confirm to execute; --force-prod overrides
 * the shared-cache endpoint guard. `entities` is fully offline.
 */
export function registerCacheCommands(parent, getClient, opts = {}) {
    const c = parent.command("cache", { hidden: !!opts.hidden }).description("Redis cache inspection and invalidation (admin/developer)");
    c.command("stats")
        .action(jsonAction(getClient, runCacheStats));
    c.command("keys")
        .option("--pattern <glob>", "", "*")
        .action(jsonAction(getClient, (client, opts) => runCacheKeys(client, opts)));
    addCacheWriteOptions(c.command("invalidate <entityType>")
        .option("--id <n>", "", (v) => Number(v))
        .option("--asiakas <n>", "", (v) => Number(v))
        // Back-compat alias for the pre-rename spelling (fb#388). `--asiakas-id` was
        // the lone outlier among 39 tenant-scoped commands — 38 spell it `--asiakas`
        // — so guessing the majority form failed here and guessing this one failed
        // everywhere else. Hidden: the spec documents only `--asiakas`, so `--help`
        // and `reference dump` show one spelling while old scripts keep working.
        .addOption(new Option("--asiakas-id <n>").argParser((v) => Number(v)).hideHelp())
        .option("--cascade")).action(jsonAction(getClient, (client, entityType, opts) => runCacheInvalidate(client, { entityType, id: opts.id, asiakasId: opts.asiakas ?? opts.asiakasId, cascade: opts.cascade }, toCacheWriteOpts(opts))));
    addCacheWriteOptions(c.command("clear")).action(jsonAction(getClient, (client, opts) => runCacheClear(client, toCacheWriteOpts(opts))));
    // The glob is dual-shaped: positional (canonical) OR `--pattern <glob>` — see
    // {@link resolveGlob} for why that alias exists (fb#645).
    addCacheWriteOptions(c
        .command("pattern [glob]")
        .option("--pattern <glob>", "Raw Redis key glob (alias for the positional)")).action(jsonAction(getClient, (client, glob, opts) => runCachePattern(client, resolveGlob(glob, opts.pattern), toCacheWriteOpts(opts))));
    c.command("entities")
        .action(guarded(() => {
        writeJson({ items: CACHE_ENTITIES, count: CACHE_ENTITIES.length });
    }));
}
//# sourceMappingURL=index.js.map