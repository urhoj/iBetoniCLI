import { listEnvelope, unwrapRows } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { addOwnerOption, parseId } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { fetchFkSources, pickFkSource, registerFkSourcesLeaf, resolveOwner } from "../_shared/foreignKeys.js";
async function fetchVehicleFk(client, vehicleId, sourceId) {
    const rows = unwrapRows(await client.get(`/api/vehicle/foreignKeys/get/${vehicleId}/${sourceId}`));
    const key = rows[0]?.foreignKey;
    return key == null || key === "" ? null : String(key);
}
async function sourceFor(client, owner, ref) {
    return pickFkSource(await fetchFkSources(client, owner), ref, owner);
}
export async function runVehicleFkGet(client, vehicleId, opts) {
    const source = await sourceFor(client, resolveOwner(client, opts.owner), opts.source);
    const key = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
    return { vehicleId, source: source.name, sourceId: source.foreignKeySourceId, key };
}
export async function runVehicleFkList(client, vehicleId, owner) {
    const sources = await fetchFkSources(client, resolveOwner(client, owner));
    const keys = await Promise.all(sources.map((s) => fetchVehicleFk(client, vehicleId, s.foreignKeySourceId)));
    const items = sources.flatMap((s, i) => keys[i] == null ? [] : [{ vehicleId, key: keys[i], source: s.name, sourceId: s.foreignKeySourceId }]);
    return listEnvelope(items, { truncated: false });
}
const SET_PATH = "/api/vehicle/foreignKeys/set";
export async function runVehicleFkSet(client, vehicleId, input, flags) {
    const source = await sourceFor(client, resolveOwner(client, input.owner), input.source);
    const current = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
    const key = input.key.trim();
    const result = {
        vehicleId,
        source: source.name,
        sourceId: source.foreignKeySourceId,
        key,
        action: current === null ? "inserted" : current === key ? "unchanged" : "updated",
    };
    if (result.action === "unchanged")
        return result;
    // Server-side dry-run: the handler echoes { dryRun:true, wouldUpdate } and skips the write.
    const server = await client.post(SET_PATH, { vehicleId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key }, { headers: writeFlagsToHeaders(flags) });
    return flags.dryRun ? { dryRun: true, would: result, server } : result;
}
export async function runVehicleFkRemove(client, vehicleId, input, flags) {
    const source = await sourceFor(client, resolveOwner(client, input.owner), input.source);
    const current = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
    const result = {
        vehicleId,
        source: source.name,
        sourceId: source.foreignKeySourceId,
        key: current,
        action: current === null ? "unchanged" : "removed",
    };
    if (result.action === "unchanged")
        return result;
    const server = await client.post(SET_PATH, { vehicleId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: "" }, { headers: writeFlagsToHeaders(flags) });
    return flags.dryRun ? { dryRun: true, would: result, server } : result;
}
export function registerVehicleFkCommands(vehicle, getClient) {
    const fk = vehicle.command("fk").description("Manage a vehicle's foreign keys (external ids per source, e.g. GPS unit ids)");
    registerFkSourcesLeaf(fk, getClient);
    addOwnerOption(fk.command("get <vehicleId>").requiredOption("--source <ref>")).action(jsonAction(getClient, (client, idStr, opts) => runVehicleFkGet(client, parseId(idStr, "vehicleId"), opts)));
    addOwnerOption(fk.command("list <vehicleId>")).action(jsonAction(getClient, (client, idStr, opts) => runVehicleFkList(client, parseId(idStr, "vehicleId"), opts.owner)));
    addWriteFlagsToCommand(addOwnerOption(fk.command("set <vehicleId>").requiredOption("--source <ref>").requiredOption("--key <text>"))).action(guarded(async (idStr, opts) => {
        writeJson(await runVehicleFkSet(await getClient(), parseId(idStr, "vehicleId"), opts, opts));
    }));
    addWriteFlagsToCommand(addOwnerOption(fk.command("remove <vehicleId>").requiredOption("--source <ref>"))).action(guarded(async (idStr, opts) => {
        writeJson(await runVehicleFkRemove(await getClient(), parseId(idStr, "vehicleId"), opts, opts));
    }));
}
//# sourceMappingURL=fk.js.map