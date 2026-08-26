import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
let expandPayloadFn;
function resolveExpandPayload() {
    if (expandPayloadFn === undefined) {
        try {
            const require = createRequire(import.meta.url);
            const codec = require("@ibetoni/auth/codec");
            expandPayloadFn =
                typeof codec.expandPayload === "function" ? codec.expandPayload : null;
        }
        catch {
            expandPayloadFn = null;
        }
    }
    return expandPayloadFn;
}
/**
 * Non-throwing shape check: does this bearer value even LOOK like a JWT?
 * Returns a human diagnostic naming what is wrong, or `null` when the shape is
 * plausible (it says nothing about the signature or expiry).
 *
 * A value that fails here can never authenticate, so callers can fail fast with
 * a message that points at the VALUE rather than at the token's validity —
 * "Malformed JWT" alone reads like a signature/expiry problem and sends you
 * looking at the wrong thing (feedback #351, where `IB_TOKEN=$(script)` had
 * captured the script's banner lines along with the JWT).
 */
export function jwtShapeProblem(token) {
    // Called out before the segment count, which would otherwise describe the empty
    // string as "got 1" — technically true, useless to act on. An empty value has a
    // distinct cause (the minting command produced no stdout) and its own remedy.
    if (token === "")
        return "the variable is set but empty (0 chars)";
    const parts = token.split(".");
    if (parts.length !== 3)
        return `expected 3 dot-separated segments, got ${parts.length} (${token.length} chars)`;
    // The segment CHARSET, not just the dot count: a banner line with no dot in it
    // ("✅ DB pool warmed up in 42ms\n" + the JWT) still splits into exactly 3
    // parts and would sail past a count-only check — while the raw string is
    // rejected by every server that reads it. Whitespace is called out by name
    // because it is the tell for a captured-stdout value.
    const bad = parts.findIndex((p) => !/^[A-Za-z0-9_-]+$/.test(p));
    if (bad !== -1) {
        const why = /\s/.test(parts[bad]) ? "contains whitespace" : "is not base64url";
        return `segment ${bad + 1} of 3 ${why} (${token.length} chars)`;
    }
    return null;
}
// One invocation decodes the SAME token several times (tier resolution in
// bin/ib.ts, the acting-as diagnostic and impersonation check in cliContext) —
// cache the last decode. Callers treat DecodedClaims as read-only.
let lastToken;
let lastClaims;
/**
 * Decode a JWT payload into typed claims.
 *
 * Uses `@ibetoni/auth/codec` `expandPayload` when reachable so we transparently
 * handle the short-shape JWT (`f` -> `issuedFor`, etc.) introduced in Plan 1.
 * Falls back to a raw base64url decode when the codec is unavailable — that
 * fallback is also the unit-test path (tests construct minimal `header.body.sig`
 * fixtures and don't depend on the workspace package being symlinked).
 */
/**
 * Shape-check, base64url-decode and (for v2 short tokens) expand a JWT payload
 * into its long-shape claim object. Shared by `decodeJwtPayload` and
 * `tokenCompanyClaims` so the two can never disagree about what the token says.
 */
function expandedPayload(jwt) {
    const problem = jwtShapeProblem(jwt);
    if (problem)
        throw new Error(`Malformed JWT: ${problem}`);
    const json = Buffer.from(jwt.split(".")[1], "base64url").toString("utf8");
    const raw = JSON.parse(json);
    if (raw.v === undefined)
        return raw;
    try {
        return resolveExpandPayload()?.(raw) ?? raw;
    }
    catch {
        // Codec rejected the payload (e.g. unknown role) — use raw shape, as the
        // old always-wrapped try/catch did.
        return raw;
    }
}
/**
 * Normalize the raw `asiakasesWithTypes` claim into typed rows. Shared by
 * `decodeJwtPayload` (which narrows to `{asiakasId, roles}`) and
 * `tokenCompanyClaims` (which keeps the flags), so the two cannot disagree about
 * what the token says — the same reason `expandedPayload` is shared.
 */
function companyClaims(expanded) {
    const raw = Array.isArray(expanded.asiakasesWithTypes)
        ? expanded.asiakasesWithTypes
        : [];
    return raw
        .map((c) => ({
        asiakasId: Number(c?.asiakasId),
        roles: Array.isArray(c?.roles) ? c.roles : [],
        isTyomaaAsiakas: c?.isTyomaaAsiakas === true,
        isPumppuToimittaja: c?.isPumppuToimittaja === true,
        isBetoniToimittaja: c?.isBetoniToimittaja === true,
        isLattiaToimittaja: c?.isLattiaToimittaja === true,
    }))
        .filter((c) => Number.isFinite(c.asiakasId));
}
export function decodeJwtPayload(jwt) {
    if (jwt === lastToken && lastClaims)
        return lastClaims;
    const expanded = expandedPayload(jwt);
    const globalRoles = (expanded.globalRoles ?? {});
    // A missing claim must surface as `undefined`, not `Number(undefined)` → NaN
    // (NaN serialises into a URL/query as the literal "NaN").
    const finite = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };
    // Active-company admin: asiakasesWithTypes carries role NAMES per company;
    // read the entry for ownerAsiakasId (the active tenant). asiakasAdmin/hrAdmin
    // mirror canSendCliNotification's gate. Absent/short token → false.
    const owner = finite(expanded.ownerAsiakasId ?? expanded.o);
    const companies = companyClaims(expanded);
    const activeRoles = companies
        .filter((c) => c.asiakasId === owner)
        .flatMap((c) => c.roles);
    const isActiveCompanyAdmin = owner !== undefined &&
        (activeRoles.includes("asiakasAdmin") || activeRoles.includes("hrAdmin"));
    const companyList = companies.map(({ asiakasId, roles }) => ({ asiakasId, roles }));
    const claims = {
        personId: finite(expanded.personId ?? expanded.sub),
        ownerAsiakasId: owner,
        ownerAsiakasName: expanded.ownerAsiakasName,
        email: expanded.email,
        issuedFor: expanded.issuedFor,
        exp: typeof expanded.exp === "number" ? expanded.exp : undefined,
        isSystemAdmin: globalRoles.isSystemAdmin === true,
        isDeveloper: globalRoles.isDeveloper === true,
        isActiveCompanyAdmin,
        imp: finite(expanded.imp ?? expanded.i),
        imp_sid: (expanded.imp_sid ?? expanded.s),
        companies: companyList,
    };
    lastToken = jwt;
    lastClaims = claims;
    return claims;
}
/**
 * The token's `asiakasesWithTypes` claim as-is, plus when the token was minted.
 *
 * This IS the authorization source: backend routes read this claim, not any
 * live membership query. It is therefore a SNAPSHOT — a company added or a role
 * granted after `mintedAt` is not in it until the token is re-minted
 * (`ib company switch`, re-login, or a refresh). Backs
 * `ib person companies --as-token` (feedback #395).
 *
 * `mintedAt` is null on COMPACT (short-shape) tokens: `@ibetoni/auth` signs
 * those with `noTimestamp: true`, so they carry no `iat` and the codec does not
 * restore one. It cannot be derived from `exp` — the TTL varies (impersonation
 * tokens are 10 min). Callers must treat null as "unknown", not "just now".
 */
export function tokenCompanyClaims(jwt) {
    const expanded = expandedPayload(jwt);
    const iat = typeof expanded.iat === "number" ? expanded.iat : null;
    return {
        mintedAt: iat === null ? null : new Date(iat * 1000).toISOString(),
        companies: companyClaims(expanded),
    };
}
/**
 * Project the impersonation claims (`imp`/`imp_sid`) into the orientation shape
 * shared by `auth whoami`, `doctor`, and `person me`. Returns `undefined` on a
 * normal (non-impersonation) token. Kept in one place so the three surfaces
 * can't drift in how they report "am I acting as someone else?".
 */
export function impersonationFromClaims(claims) {
    return claims.imp != null
        ? { actorPersonId: claims.imp, sessionId: claims.imp_sid ?? "" }
        : undefined;
}
//# sourceMappingURL=jwt.js.map