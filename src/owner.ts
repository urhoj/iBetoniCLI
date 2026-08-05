import type { ApiClient } from "./api/client.js";
import { decodeJwtPayload } from "./auth/jwt.js";
import { failWith } from "./output/json.js";

/**
 * The default escape hatch named in the failure message. A call site whose
 * command offers a different one (`--asiakas`, a `--body` field) passes its own.
 */
const DEFAULT_HINT = "run `ib auth switch`, or pass --owner";

/** The one message every owner-resolution failure emits, so the exit-4 contract reads identically everywhere. */
const unresolvable = (hint: string): never =>
  failWith(`could not resolve active company — ${hint}`, 4);

/**
 * The active company id straight from the presented JWT's `ownerAsiakasId`
 * claim — synchronous, no network, exit 4 when the claim is absent or unusable.
 *
 * Six modules had hand-rolled this decode with three different failure
 * contracts (two of them a bare `Error`, i.e. exit 1 — an auth/context problem
 * reported as an unexpected crash). Use this whenever the owner id is needed
 * inside a synchronous code path; use {@link resolveActiveOwnerAsiakasId} when
 * you can await and want the server fallback for tokens missing the claim.
 *
 * @param hint appended to the error message so each call site can name its own
 *   escape hatch (e.g. `--owner`, `--asiakas`, or a `--body` field).
 */
export function ownerAsiakasIdFromToken(
  client: ApiClient,
  hint = DEFAULT_HINT
): number {
  try {
    const owner = decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId;
    if (typeof owner === "number" && owner > 0) return owner;
  } catch {
    // Undecodable/absent token claim — same outcome as an unusable one.
  }
  return unresolvable(hint);
}

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
 * @param hint see {@link ownerAsiakasIdFromToken}.
 */
export async function resolveActiveOwnerAsiakasId(
  client: ApiClient,
  hint = DEFAULT_HINT
): Promise<number> {
  try {
    const owner = decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId;
    if (typeof owner === "number" && owner > 0) return owner;
  } catch {
    // Undecodable/absent token claim — ask the server.
  }
  const available = await client.get<{ currentCompanyId?: number }>(
    "/api/company-selection/available"
  );
  if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
    return unresolvable(hint);
  }
  return available.currentCompanyId;
}
