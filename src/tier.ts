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

export type CallerTier = "developer" | "standard";

/** Deterministic: map a JWT (or none) to a visibility tier. Fail-closed on missing/bad token. */
export function resolveCallerTier(token: string | null | undefined): CallerTier {
  if (!token) return "standard";
  try {
    const claims = decodeJwtPayload(token);
    return claims.isDeveloper || claims.isSystemAdmin ? "developer" : "standard";
  } catch {
    return "standard";
  }
}

/** A developer-tier command is hidden from any non-developer caller. */
export function isHiddenAtTier(
  spec: { tier?: "developer" },
  tier: CallerTier
): boolean {
  return spec.tier === "developer" && tier !== "developer";
}

/** Keep only the specs visible at `tier`. */
export function visibleSpecs<T extends { tier?: "developer" }>(
  specs: T[],
  tier: CallerTier
): T[] {
  return specs.filter((s) => !isHiddenAtTier(s, tier));
}

/** The domain token of a command path (`ib keikka list` → `keikka`). */
export function domainOf(command: string): string {
  return command.split(" ")[1];
}

/**
 * Domains every visible leaf of which is hidden at `tier` — i.e. the whole
 * domain has zero visible leaves and should disappear from discovery
 * (e.g. ai/schema/changelog at "standard"). Empty at "developer". Single source
 * for the root-help command filter (`fullyHiddenDomains`) and the primer
 * glossary filter (`glossaryForTier`), which must stay in lock-step.
 */
export function hiddenDomainsAtTier<T extends { command: string; tier?: "developer" }>(
  specs: T[],
  tier: CallerTier
): Set<string> {
  const visible = new Set(visibleSpecs(specs, tier).map((s) => domainOf(s.command)));
  return new Set(specs.map((s) => domainOf(s.command)).filter((d) => d && !visible.has(d)));
}

// Ambient holder — see module docstring. Default "developer" = full surface.
let ambientTier: CallerTier = "developer";
export function setCallerTier(tier: CallerTier): void {
  ambientTier = tier;
}
export function getCallerTier(): CallerTier {
  return ambientTier;
}
