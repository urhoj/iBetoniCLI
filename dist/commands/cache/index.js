import { Option } from "commander";
import { writeJson, failWith } from "../../output/json.js";
import { assertWritableEndpoint } from "../../api/endpointGuard.js";
import { CACHE_ENTITIES } from "./entities.js";
import { jsonAction, guarded } from "../_shared/action.js";
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
 * (canonical) or as `--pattern <glob>` — the string twin of `resolveTarget` /
 * `resolveDateInput` in `src/targets.ts`. Exactly one is required; both are
 * allowed only when they agree, so a copy-paste that supplies each once is not
 * punished while two DIFFERENT globs (only one of which could be honoured) is.
 *
 * Not routed through `resolveTarget`: that one coerces to a positive integer,
 * which every glob would fail.
 */
export function resolveGlob(positional, flag) {
    const glob = positional ?? flag;
    if (glob === undefined || glob === "") {
        failWith("missing target: pass <glob> positionally or via --pattern <glob>", 4, "use `ib dev cache keys --pattern '<glob>'` first to see what a glob matches");
    }
    if (positional !== undefined && flag !== undefined && positional !== flag) {
        failWith(`positional glob (${positional}) and --pattern (${flag}) differ — pass only one`, 4);
    }
    return glob;
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
export function registerCacheCommands(parent, getClient, opts = {}) {
    const c = parent.command("cache", { hidden: !!opts.hidden }).description("Redis cache inspection and invalidation (admin/developer)");
    c.command("stats")
        .action(jsonAction(getClient, runCacheStats));
    c.command("keys")
        .option("--pattern <glob>", "", "*")
        .action(jsonAction(getClient, (client, opts) => runCacheKeys(client, opts)));
    c.command("invalidate <entityType>")
        .option("--id <n>", "", (v) => Number(v))
        .option("--asiakas <n>", "", (v) => Number(v))
        // Back-compat alias for the pre-rename spelling (fb#388). `--asiakas-id` was
        // the lone outlier among 39 tenant-scoped commands — 38 spell it `--asiakas`
        // — so guessing the majority form failed here and guessing this one failed
        // everywhere else. Hidden: the spec documents only `--asiakas`, so `--help`
        // and `reference dump` show one spelling while old scripts keep working.
        .addOption(new Option("--asiakas-id <n>").argParser((v) => Number(v)).hideHelp())
        .option("--cascade")
        .option("--confirm")
        .option("--dry-run")
        .option("--force-prod")
        .option("--reason <text>")
        .action(jsonAction(getClient, (client, entityType, opts) => runCacheInvalidate(client, { entityType, id: opts.id, asiakasId: opts.asiakas ?? opts.asiakasId, cascade: opts.cascade }, { confirm: !!opts.confirm, dryRun: !!opts.dryRun, forceProd: !!opts.forceProd, reason: opts.reason })));
    c.command("clear")
        .option("--confirm")
        .option("--dry-run")
        .option("--force-prod")
        .option("--reason <text>")
        .action(jsonAction(getClient, (client, opts) => runCacheClear(client, { confirm: !!opts.confirm, dryRun: !!opts.dryRun, forceProd: !!opts.forceProd, reason: opts.reason })));
    // The glob is dual-shaped: positional (canonical) OR `--pattern <glob>`. The
    // sibling `cache keys` spells the very same concept — a Redis SCAN glob — as a
    // flag, so reaching for `--pattern` here is the natural error rather than a
    // careless one (fb#645). Flag-vs-positional twin of the `src/targets.ts`
    // dual-target pattern; resolved inline because the value is a glob string, not
    // a positive-integer id.
    c.command("pattern [glob]")
        .option("--pattern <glob>", "Raw Redis key glob (alias for the positional)")
        .option("--confirm")
        .option("--dry-run")
        .option("--force-prod")
        .option("--reason <text>")
        .action(jsonAction(getClient, (client, glob, opts) => runCachePattern(client, resolveGlob(glob, opts.pattern), {
        confirm: !!opts.confirm,
        dryRun: !!opts.dryRun,
        forceProd: !!opts.forceProd,
        reason: opts.reason,
    })));
    c.command("entities")
        .action(guarded(() => {
        writeJson({ items: CACHE_ENTITIES, count: CACHE_ENTITIES.length });
    }));
}
//# sourceMappingURL=index.js.map