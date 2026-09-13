/**
 * `ib vehicle fk` — vehicle foreign keys (dbo.vehicleForeignKeys), fb#1683.
 *
 * One key per (vehicle, source), no owner column — the tenant gate is
 * resolved from the vehicle server-side; `--owner` here only picks WHOSE
 * source list `--source` is resolved against. The backend has no list-all
 * route (only `get/:vehicleId/:sourceId`), so `list` fans out over the owner's
 * sources. `POST /foreignKeys/set` is delete+insert and honours X-Dry-Run;
 * an empty `foreignKey` IS its delete, which `remove` sends.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, unwrapRows, type ListEnvelope } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { addOwnerOption, parseId } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { fetchFkSources, registerFkSourcesLeaf, resolveFkSource, resolveOwner } from "../_shared/foreignKeys.js";

export interface VehicleFkRow {
  vehicleId: number;
  key: string;
  source: string;
  sourceId: number;
}

async function fetchVehicleFk(client: ApiClient, vehicleId: number, sourceId: number): Promise<string | null> {
  const rows = unwrapRows(await client.get(`/api/vehicle/foreignKeys/get/${vehicleId}/${sourceId}`));
  const key = rows[0]?.foreignKey;
  return key == null || key === "" ? null : String(key);
}

export async function runVehicleFkGet(
  client: ApiClient,
  vehicleId: number,
  opts: { source: string; owner?: number }
): Promise<{ vehicleId: number; source: string; sourceId: number; key: string | null }> {
  const source = await resolveFkSource(client, resolveOwner(client, opts.owner), opts.source);
  const key = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
  return { vehicleId, source: source.name, sourceId: source.foreignKeySourceId, key };
}

export async function runVehicleFkList(client: ApiClient, vehicleId: number, owner?: number): Promise<ListEnvelope<VehicleFkRow>> {
  const sources = await fetchFkSources(client, resolveOwner(client, owner));
  const keys = await Promise.all(sources.map((s) => fetchVehicleFk(client, vehicleId, s.foreignKeySourceId)));
  const items = sources.flatMap((s, i) =>
    keys[i] == null ? [] : [{ vehicleId, key: keys[i] as string, source: s.name, sourceId: s.foreignKeySourceId }]
  );
  return listEnvelope(items, { truncated: false });
}

export interface VehicleFkWriteResult {
  vehicleId: number;
  source: string;
  sourceId: number;
  key: string | null;
  action: "inserted" | "updated" | "unchanged" | "removed";
}

type VehicleFkWrite = VehicleFkWriteResult | { dryRun: true; would: VehicleFkWriteResult; server: unknown };

/**
 * One body for set (nextKey = the new value) and remove (nextKey = "", the
 * backend's delete form). Reads the current key to name the action; `unchanged`
 * sends nothing. Otherwise POSTs — the route honours X-Dry-Run and echoes the
 * would-be row, returned under `server`.
 */
async function writeVehicleFk(
  client: ApiClient,
  vehicleId: number,
  input: { source: string; owner?: number },
  nextKey: string,
  flags: WriteFlags
): Promise<VehicleFkWrite> {
  const source = await resolveFkSource(client, resolveOwner(client, input.owner), input.source);
  const current = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
  const removing = nextKey === "";
  const result: VehicleFkWriteResult = {
    vehicleId,
    source: source.name,
    sourceId: source.foreignKeySourceId,
    key: removing ? current : nextKey,
    action: removing
      ? (current === null ? "unchanged" : "removed")
      : (current === null ? "inserted" : current === nextKey ? "unchanged" : "updated"),
  };
  if (result.action === "unchanged") return flags.dryRun ? { dryRun: true, would: result, server: null } : result;
  const server = await client.post(
    "/api/vehicle/foreignKeys/set",
    { vehicleId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: nextKey },
    { headers: writeFlagsToHeaders(flags) }
  );
  return flags.dryRun ? { dryRun: true, would: result, server } : result;
}

export const runVehicleFkSet = (
  client: ApiClient,
  vehicleId: number,
  input: { source: string; key: string; owner?: number },
  flags: WriteFlags
): Promise<VehicleFkWrite> => writeVehicleFk(client, vehicleId, input, input.key.trim(), flags);

export const runVehicleFkRemove = (
  client: ApiClient,
  vehicleId: number,
  input: { source: string; owner?: number },
  flags: WriteFlags
): Promise<VehicleFkWrite> => writeVehicleFk(client, vehicleId, input, "", flags);

export function registerVehicleFkCommands(vehicle: Command, getClient: () => Promise<ApiClient>): void {
  const fk = vehicle.command("fk").description("Manage a vehicle's foreign keys (external ids per source, e.g. GPS unit ids)");

  registerFkSourcesLeaf(fk, getClient);

  addOwnerOption(fk.command("get <vehicleId>").requiredOption("--source <ref>")).action(
    jsonAction(getClient, (client, idStr: string, opts: { source: string; owner?: number }) =>
      runVehicleFkGet(client, parseId(idStr, "vehicleId"), opts)
    )
  );

  addOwnerOption(fk.command("list <vehicleId>")).action(
    jsonAction(getClient, (client, idStr: string, opts: { owner?: number }) => runVehicleFkList(client, parseId(idStr, "vehicleId"), opts.owner))
  );

  addWriteFlagsToCommand(addOwnerOption(fk.command("set <vehicleId>").requiredOption("--source <ref>").requiredOption("--key <text>"))).action(
    guarded(async (idStr: string, opts: WriteFlags & { source: string; key: string; owner?: number }) => {
      writeJson(await runVehicleFkSet(await getClient(), parseId(idStr, "vehicleId"), opts, opts));
    })
  );

  addWriteFlagsToCommand(addOwnerOption(fk.command("remove <vehicleId>").requiredOption("--source <ref>"))).action(
    guarded(async (idStr: string, opts: WriteFlags & { source: string; owner?: number }) => {
      writeJson(await runVehicleFkRemove(await getClient(), parseId(idStr, "vehicleId"), opts, opts));
    })
  );
}
