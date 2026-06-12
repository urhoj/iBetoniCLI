import type { ApiClient } from "./api/client.js";

/**
 * Resolve the caller's active ownerAsiakasId via
 * GET /api/company-selection/available — the one shared implementation of the
 * guard previously copied into the log/person/customer/sijainti modules
 * (customer's copy lacked the guard and could leak `undefined` into URLs).
 * Worksite deliberately keeps its own resolver: a synchronous JWT-claim read,
 * a different contract.
 *
 * @param hint appended to the error message so each call site can name its
 *   own escape hatch (e.g. `--owner`, `--asiakas`, or a `--body` field).
 */
export async function resolveActiveOwnerAsiakasId(
  client: ApiClient,
  hint = "run `ib auth switch`, or pass --owner"
): Promise<number> {
  const available = await client.get<{ currentCompanyId?: number }>(
    "/api/company-selection/available"
  );
  if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
    throw new Error(`could not resolve active company — ${hint}`);
  }
  return available.currentCompanyId;
}
