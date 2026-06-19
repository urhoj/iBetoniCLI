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
// Ambient holder — see module docstring. Default "developer" = full surface.
let ambientTier = "developer";
export function setCallerTier(tier) {
    ambientTier = tier;
}
export function getCallerTier() {
    return ambientTier;
}
//# sourceMappingURL=tier.js.map