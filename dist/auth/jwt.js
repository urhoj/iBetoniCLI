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
    return {
        personId: Number(expanded.personId ?? expanded.sub),
        ownerAsiakasId: Number(expanded.ownerAsiakasId ?? expanded.o),
        ownerAsiakasName: expanded.ownerAsiakasName,
        email: expanded.email,
        issuedFor: expanded.issuedFor,
        exp: typeof expanded.exp === "number" ? expanded.exp : undefined,
        isSystemAdmin: globalRoles.isSystemAdmin === true,
        isDeveloper: globalRoles.isDeveloper === true,
    };
}
//# sourceMappingURL=jwt.js.map