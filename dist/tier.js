/**
 * Caller visibility tier + the discovery hiding predicate.
 *
 * `tier` gates what an AI/CLI caller SEES in discovery — not what it can run
 * (the server enforces real permissions). A command tagged `tier: "developer"`
 * (see `CommandSpec` in output/help.ts) is hidden from callers that are not a
 * global developer/sysadmin. Resolution is fail-closed: no/invalid token =
 * "standard" = the privileged subtrees are hidden.
 *
 * The ambient holder is set once per invocation by the entry points
 * (`bin/ib.ts`, `runArgv.ts`) and read at render time by the help closures and
 * the `ib commands` / `ib reference dump` actions. It defaults to "developer"
 * (full surface) so direct library/test use of the built program is unfiltered;
 * the real per-caller tier is always set before argv is parsed.
 */
import { decodeJwtPayload } from "./auth/jwt.js";
const CALLER_RANK = { standard: 0, admin: 1, developer: 2 };
const specRank = (tier) => tier === "developer" ? 2 : tier === "admin" ? 1 : 0;
/** Stateless: map a JWT (or none) to a visibility tier. Fail-closed on missing/bad token. */
export function resolveCallerTier(token) {
    if (!token)
        return "standard";
    try {
        const claims = decodeJwtPayload(token);
        if (claims.isDeveloper || claims.isSystemAdmin)
            return "developer";
        if (claims.isActiveCompanyAdmin)
            return "admin";
        return "standard";
    }
    catch {
        return "standard";
    }
}
/** A command is hidden when its required tier outranks the caller's tier. */
export function isHiddenAtTier(spec, tier) {
    return specRank(spec.tier) > CALLER_RANK[tier];
}
/** Keep only the specs visible at `tier`. */
export function visibleSpecs(specs, tier) {
    return specs.filter((s) => !isHiddenAtTier(s, tier));
}
/** The domain token of a command path (`ib keikka list` → `keikka`). */
export function domainOf(command) {
    return command.split(" ")[1];
}
/**
 * Domains every visible leaf of which is hidden at `tier` — i.e. the whole
 * domain has zero visible leaves and should disappear from discovery
 * (e.g. ai/schema/changelog at "standard"). Empty at "developer". Used by
 * the root-help command filter (`fullyHiddenDomains`) and the domain index
 * builder in `commandsList.ts`.
 */
export function hiddenDomainsAtTier(specs, tier) {
    const visible = new Set(visibleSpecs(specs, tier).map((s) => domainOf(s.command)));
    return new Set(specs.map((s) => domainOf(s.command)).filter((d) => d && !visible.has(d)));
}
/**
 * The full command paths hidden at `tier` — the needle list every cross-reference
 * scrub matches against. Pass the WHOLE catalogue (not the visible subset): the
 * paths being scrubbed are precisely the ones filtered out of it.
 */
export function hiddenCommandPaths(specs, tier) {
    return specs.filter((s) => isHiddenAtTier(s, tier)).map((s) => s.command);
}
/**
 * Stand-in for an error remedy that names a command the caller cannot see. The
 * row itself is KEPT — `exit`/`http` are the documented error contract, and a
 * caller who actually HITS the error still gets the real remedy at runtime
 * (`hintForError` reads the raw specs; by then it is recovery, not discovery).
 * Wording mirrors `hiddenAtTierMessage`.
 */
const REDACTED_REMEDY = "not available at your access level — run `ib commands` to see what you can run";
/**
 * One RegExp alternation of the hidden paths, replacing the per-string
 * `hiddenCommands.some((h) => s.includes(h))` loop (~38 paths × ~6k strings =
 * 221k `includes` calls for a standard-tier `ib reference dump`). Plain escaped
 * literals with no anchors or flags, so it matches exactly the same substrings.
 * Memoized on the ARRAY identity — the dump hoists `hiddenCommandPaths(...)`
 * once and passes that same array for all ~311 specs, so it compiles once.
 */
const hiddenMatcherCache = new WeakMap();
function hiddenMatcher(hiddenCommands) {
    let re = hiddenMatcherCache.get(hiddenCommands);
    if (re === undefined) {
        // An empty alternation would compile to //, which matches EVERYTHING.
        re = hiddenCommands.length
            ? new RegExp(hiddenCommands.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"))
            : null;
        hiddenMatcherCache.set(hiddenCommands, re);
    }
    const compiled = re;
    return compiled ? (s) => compiled.test(s) : () => false;
}
/**
 * Tier-scrub a spec's ERRORS rows. An error row cannot just be filtered out on
 * any mention the way a note can, so the two fields are handled differently:
 *
 * - `meaning` names a hidden command → the row is ABOUT that command; drop it.
 * - `remedy` names one → keep the row (its exit/HTTP contract still applies),
 *   replace the prose with {@link REDACTED_REMEDY}.
 *
 * Substring-replacing the path in place is not an option: it strands whatever
 * follows it (`"ib auth impersonate --end to restore…"` → `"… --end to restore…"`).
 */
function scrubErrorsForTier(errors, mentionsHidden) {
    return errors
        .filter((e) => !mentionsHidden(e.meaning))
        .map((e) => mentionsHidden(e.remedy) ? { ...e, remedy: REDACTED_REMEDY } : e);
}
/**
 * For a non-developer tier, strip cross-references that name a command hidden at
 * that tier — otherwise a VISIBLE command's own text teaches a standard caller
 * that the hidden subtrees exist (tier filtering decides WHICH specs render; this
 * decides what each surviving spec may say). Applied by both discovery surfaces:
 * `ib reference dump` and leaf `--help`. Developer tier: spec returned unchanged
 * (byte-for-byte parity). `hiddenCommands` are full paths (e.g. `ib dev ai
 * conversation`) from {@link hiddenCommandPaths}, matched as substrings.
 *
 * Prose arrays (`seeAlso`/`notes`/`examples`) lose the offending entry; `errors`
 * are scrubbed per {@link scrubErrorsForTier}. `description`/`outputShape`/flag
 * descriptions are NOT scrubbed — there is nothing to drop without destroying the
 * spec, so that half of the invariant stays test-enforced (`dump.test.ts` asserts
 * the whole dump JSON names no hidden path, at every tier).
 */
export function scrubSpecForTier(spec, tier, hiddenCommands) {
    if (tier === "developer")
        return spec;
    const mentionsHidden = hiddenMatcher(hiddenCommands);
    const out = { ...spec };
    if (spec.seeAlso)
        out.seeAlso = spec.seeAlso.filter((r) => !mentionsHidden(r));
    if (spec.notes)
        out.notes = spec.notes.filter((n) => !mentionsHidden(n));
    if (spec.examples)
        out.examples = spec.examples.filter((e) => !mentionsHidden(e));
    out.errors = scrubErrorsForTier(spec.errors, mentionsHidden);
    return out;
}
// Ambient holder — see module docstring. Default "developer" = full surface.
let ambientTier = "developer";
export function setCallerTier(tier) {
    ambientTier = tier;
}
export function getCallerTier() {
    return ambientTier;
}
//# sourceMappingURL=tier.js.map