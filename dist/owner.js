import { decodeJwtPayload } from "./auth/jwt.js";
/**
 * Resolve the caller's active ownerAsiakasId — the one shared implementation
 * of the guard previously copied into the log/person/customer/sijainti modules
 * (customer's copy lacked the guard and could leak `undefined` into URLs).
 *
 * Decode-first: the backend's `currentCompanyId` is literally the presented
 * JWT's own `ownerAsiakasId` claim echoed back (`companySelectionRoutes`
 * reads `req.user`), so the local decode answers identically for free — no
 * round-trip. GET /api/company-selection/available stays as the fallback for
 * tokens whose claim is absent or undecodable.
 *
 * @param hint appended to the error message so each call site can name its
 *   own escape hatch (e.g. `--owner`, `--asiakas`, or a `--body` field).
 */
export async function resolveActiveOwnerAsiakasId(client, hint = "run `ib auth switch`, or pass --owner") {
    try {
        const owner = decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId;
        if (typeof owner === "number" && owner > 0)
            return owner;
    }
    catch {
        // Undecodable/absent token claim — ask the server.
    }
    const available = await client.get("/api/company-selection/available");
    if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
        throw new Error(`could not resolve active company — ${hint}`);
    }
    return available.currentCompanyId;
}
//# sourceMappingURL=owner.js.map