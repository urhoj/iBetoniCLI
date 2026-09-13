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
import { fetchFkSources, pickFkSource, registerFkSourcesLeaf, resolveOwner, type FkSource } from "../_shared/foreignKeys.js";

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

async function sourceFor(client: ApiClient, owner: number, ref: string): Promise<FkSource> {
  return pickFkSource(await fetchFkSources(client, owner), ref, owner);
}

export async function runVehicleFkGet(
  client: ApiClient,
  vehicleId: number,
  opts: { source: string; owner?: number }
): Promise<{ vehicleId: number; source: string; sourceId: number; key: string | null }> {
  const source = await sourceFor(client, resolveOwner(client, opts.owner), opts.source);
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

const SET_PATH = "/api/vehicle/foreignKeys/set";

export async function runVehicleFkSet(
  client: ApiClient,
  vehicleId: number,
  input: { source: string; key: string; owner?: number },
  flags: WriteFlags
): Promise<VehicleFkWriteResult | { dryRun: true; would: VehicleFkWriteResult; server: unknown }> {
  const source = await sourceFor(client, resolveOwner(client, input.owner), input.source);
  const current = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
  const key = input.key.trim();
  const result: VehicleFkWriteResult = {
    vehicleId,
    source: source.name,
    sourceId: source.foreignKeySourceId,
    key,
    action: current === null ? "inserted" : current === key ? "unchanged" : "updated",
  };
  if (result.action === "unchanged") return result;
  // Server-side dry-run: the handler echoes { dryRun:true, wouldUpdate } and skips the write.
  const server = await client.post(SET_PATH, { vehicleId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key }, { headers: writeFlagsToHeaders(flags) });
  return flags.dryRun ? { dryRun: true, would: result, server } : result;
}

export async function runVehicleFkRemove(
  client: ApiClient,
  vehicleId: number,
  input: { source: string; owner?: number },
  flags: WriteFlags
): Promise<VehicleFkWriteResult | { dryRun: true; would: VehicleFkWriteResult; server: unknown }> {
  const source = await sourceFor(client, resolveOwner(client, input.owner), input.source);
  const current = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
  const result: VehicleFkWriteResult = {
    vehicleId,
    source: source.name,
    sourceId: source.foreignKeySourceId,
    key: current,
    action: current === null ? "unchanged" : "removed",
  };
  if (result.action === "unchanged") return result;
  const server = await client.post(SET_PATH, { vehicleId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: "" }, { headers: writeFlagsToHeaders(flags) });
  return flags.dryRun ? { dryRun: true, would: result, server } : result;
}

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
