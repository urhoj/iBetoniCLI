import type { ListEnvelope } from "../../api/envelopes.js";

type Row = Record<string, unknown>;

/**
 * Legacy per-tenant sentinel rows live in `dbo.vehicle` alongside real trucks
 * (tenant 8 has `vehicleId 0` / "Ei tietoa"; they are NOT system-wide — tenants
 * 26/30/62 have none). They surface in every vehicle list because
 * `listVehiclesForCli` filters only on `ownerAsiakasId` + `deletedTime`, yet
 * nothing downstream accepts them: `parseId` rejects a non-positive id, so
 * `ib vehicle get 0` and `ib vehicle driver assign 0 …` both exit 4. An AI
 * reading the board therefore sees what looks like an assignable driverless
 * vehicle and can only discover otherwise by trying (fb#380).
 *
 * `vehicleId < 1` is the test rather than `=== 0` because the disqualifier is
 * exactly `parseId`'s positive-integer rule — anything it would refuse is a
 * row you cannot act on.
 */
export function isPlaceholderVehicleId(vehicleId: unknown): boolean {
  return typeof vehicleId === "number" && vehicleId < 1;
}

/**
 * Stamp `placeholder: true` on sentinel rows of a vehicle-shaped list envelope.
 * Annotates rather than filters: dropping rows would silently disagree with the
 * envelope `count` and hide data the caller may legitimately want to see.
 *
 * The key is added ONLY to sentinel rows (absent = a real, addressable
 * vehicle), so the ~1 sentinel per tenant costs nothing on the other rows.
 * Every other envelope key (`nextCursor`/`count`/`truncated`) passes through.
 */
export function markPlaceholderVehicles<T extends ListEnvelope<Row>>(env: T): T {
  return {
    ...env,
    items: env.items.map((row) =>
      isPlaceholderVehicleId(row?.vehicleId) ? { ...row, placeholder: true } : row
    ),
  };
}
