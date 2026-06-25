import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
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
    const parts = jwt.split(".");
    if (parts.length !== 3)
        throw new Error("Malformed JWT");
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const raw = JSON.parse(json);
    let expanded = raw;
    try {
        const require = createRequire(import.meta.url);
        const codec = require("@ibetoni/auth/codec");
        if (typeof codec.expandPayload === "function") {
            expanded = codec.expandPayload(raw);
        }
    }
    catch {
        // Codec unavailable (e.g., during unit tests that mock JWTs). Use raw shape.
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
    return {
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