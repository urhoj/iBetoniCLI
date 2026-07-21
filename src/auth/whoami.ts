import type { CallerTier } from "../tier.js";
import { impersonationFromClaims, type DecodedClaims } from "./jwt.js";

export interface WhoamiOutput {
  personId: number | null;
  /** The token's human identifier — the JWT carries no person NAME, only email. */
  email?: string;
  activeCompany: {
    asiakasId: number | null;
    name: string | null;
    /** Loud marker when acting as the BetoniJerry umbrella tenant (asiakasId 1349). */
    betoniJerryUmbrella?: true;
  };
  /**
   * What this caller can DO: developer (schema/ai/changelog + everything) >
   * admin (active-company admin subtrees) > standard. Mirrors the discovery
   * gate, so it tells an AI which command subtrees even exist for it.
   */
  tier: CallerTier;
  /**
   * Every company this token may act as (`company switch` targets), each with
   * the roles held there. Answers "where can I act / how do I switch" in one
   * call. No company name in the JWT for non-active entries — use
   * `ib company list` for names.
   */
  companies: Array<{ asiakasId: number; roles: string[] }>;
  endpoint: string;
  /** `file` = refreshable creds store; `env` = IB_TOKEN (non-refreshable). */
  source: "file" | "env";
  /** True when the session write-lock (--read-only / IB_READ_ONLY) is active. */
  readOnly: boolean;
  /** ISO timestamp the JWT expires; with `tokenExpired` for a one-glance check. */
  tokenExpiresAt?: string;
  tokenExpired?: boolean;
  /** True when whoami found the stored JWT expired and self-healed the session
   * (JWT-bearer refresh or OAuth refresh_token grant) before reporting. */
  refreshed?: true;
  /** Present only while an impersonation session is active. */
  impersonating?: { actorPersonId: number; sessionId: string };
}

/**
 * Project the active session into the stable `whoami` JSON shape — the one-shot
 * orientation an AI reads first: who/where it is, what it can do (`tier`), where
 * else it can act (`companies`), and token/lock health. Built from the decoded
 * JWT (so it works for BOTH file and `IB_TOKEN` sessions, unlike the old
 * creds-file projection). Pure — no I/O, no decode; the caller resolves the
 * token, decodes it, and computes the tier.
 */
export function renderWhoami(input: {
  claims: DecodedClaims;
  endpoint: string;
  source: "file" | "env";
  readOnly: boolean;
  tier: CallerTier;
  /** Injectable for deterministic token-expiry tests; defaults to Date.now(). */
  nowMs?: number;
  /** From the creds profile (file sessions); falls back to the JWT imp claims. */
  impersonation?: { actorPersonId: number; sessionId: string };
}): WhoamiOutput {
  const { claims, endpoint, source, readOnly, tier } = input;
  const now = input.nowMs ?? Date.now();
  const asiakasId = claims.ownerAsiakasId ?? null;

  const out: WhoamiOutput = {
    personId: claims.personId ?? null,
    activeCompany: { asiakasId, name: claims.ownerAsiakasName ?? null },
    tier,
    companies: claims.companies,
    endpoint,
    source,
    readOnly,
  };
  if (claims.email) out.email = claims.email;
  if (asiakasId === 1349) out.activeCompany.betoniJerryUmbrella = true;
  if (claims.exp != null) {
    out.tokenExpiresAt = new Date(claims.exp * 1000).toISOString();
    out.tokenExpired = claims.exp * 1000 < now;
  }
  const impersonating = input.impersonation ?? impersonationFromClaims(claims);
  if (impersonating) out.impersonating = impersonating;
  return out;
}
