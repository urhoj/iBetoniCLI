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
export function decodeJwtPayload(jwt) {
    if (jwt === lastToken && lastClaims)
        return lastClaims;
    const problem = jwtShapeProblem(jwt);
    if (problem)
        throw new Error(`Malformed JWT: ${problem}`);
    const parts = jwt.split(".");
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const raw = JSON.parse(json);
    let expanded = raw;
    if (raw.v !== undefined) {
        try {
            expanded = resolveExpandPayload()?.(raw) ?? raw;
        }
        catch {
            // Codec rejected the payload (e.g. unknown role) — use raw shape, as the
            // old always-wrapped try/catch did.
        }
    }
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
    const companies = Array.isArray(expanded.asiakasesWithTypes)
        ? expanded.asiakasesWithTypes
        : [];
    const activeRoles = companies
        .filter((c) => finite(c?.asiakasId) === owner)
        .flatMap((c) => (Array.isArray(c?.roles) ? c.roles : []));
    const isActiveCompanyAdmin = owner !== undefined &&
        (activeRoles.includes("asiakasAdmin") || activeRoles.includes("hrAdmin"));
    const companyList = companies
        .map((c) => ({
        asiakasId: finite(c?.asiakasId),
        roles: Array.isArray(c?.roles) ? c.roles : [],
    }))
        .filter((c) => c.asiakasId !== undefined);
    const claims = {
        personId: finite(expanded.personId ?? expanded.sub),
        ownerAsiakasId: finite(expanded.ownerAsiakasId ?? expanded.o),
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