import { impersonationFromClaims } from "./jwt.js";
/**
 * Project the active session into the stable `whoami` JSON shape — the one-shot
 * orientation an AI reads first: who/where it is, what it can do (`tier`), where
 * else it can act (`companies`), and token/lock health. Built from the decoded
 * JWT (so it works for BOTH file and `IB_TOKEN` sessions, unlike the old
 * creds-file projection). Pure — no I/O, no decode; the caller resolves the
 * token, decodes it, and computes the tier.
 */
export function renderWhoami(input) {
    const { claims, endpoint, source, readOnly, tier } = input;
    const now = input.nowMs ?? Date.now();
    const asiakasId = claims.ownerAsiakasId ?? null;
    const out = {
        personId: claims.personId ?? null,
        activeCompany: { asiakasId, name: claims.ownerAsiakasName ?? null },
        tier,
        companies: claims.companies,
        endpoint,
        source,
        readOnly,
    };
    if (claims.email)
        out.email = claims.email;
    if (asiakasId === 1349)
        out.activeCompany.betoniJerryUmbrella = true;
    if (claims.exp != null) {
        out.tokenExpiresAt = new Date(claims.exp * 1000).toISOString();
        out.tokenExpired = claims.exp * 1000 < now;
    }
    const impersonating = input.impersonation ?? impersonationFromClaims(claims);
    if (impersonating)
        out.impersonating = impersonating;
    return out;
}
//# sourceMappingURL=whoami.js.map