import { listEnvelope, unwrapRows } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { addOwnerOption, parseId } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { fetchFkSources, registerFkSourcesLeaf, resolveFkSource, resolveOwner } from "../_shared/foreignKeys.js";
async function fetchVehicleFk(client, vehicleId, sourceId) {
    const rows = unwrapRows(await client.get(`/api/vehicle/foreignKeys/get/${vehicleId}/${sourceId}`));
    const key = rows[0]?.foreignKey;
    return key == null || key === "" ? null : String(key);
}
export async function runVehicleFkGet(client, vehicleId, opts) {
    const source = await resolveFkSource(client, resolveOwner(client, opts.owner), opts.source);
    const key = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
    return { vehicleId, source: source.name, sourceId: source.foreignKeySourceId, key };
}
export async function runVehicleFkList(client, vehicleId, owner) {
    const sources = await fetchFkSources(client, resolveOwner(client, owner));
    const keys = await Promise.all(sources.map((s) => fetchVehicleFk(client, vehicleId, s.foreignKeySourceId)));
    const items = sources.flatMap((s, i) => keys[i] == null ? [] : [{ vehicleId, key: keys[i], source: s.name, sourceId: s.foreignKeySourceId }]);
    return listEnvelope(items, { truncated: false });
}
/**
 * One body for set (nextKey = the new value) and remove (nextKey = "", the
 * backend's delete form). Reads the current key to name the action; `unchanged`
 * sends nothing. Otherwise POSTs — the route honours X-Dry-Run and echoes the
 * would-be row, returned under `server`.
 */
async function writeVehicleFk(client, vehicleId, input, nextKey, flags) {
    const source = await resolveFkSource(client, resolveOwner(client, input.owner), input.source);
    const current = await fetchVehicleFk(client, vehicleId, source.foreignKeySourceId);
    const removing = nextKey === "";
    const result = {
        vehicleId,
        source: source.name,
        sourceId: source.foreignKeySourceId,
        key: removing ? current : nextKey,
        action: removing
            ? (current === null ? "unchanged" : "removed")
            : (current === null ? "inserted" : current === nextKey ? "unchanged" : "updated"),
    };
    if (result.action === "unchanged")
        return flags.dryRun ? { dryRun: true, would: result, server: null } : result;
    const server = await client.post("/api/vehicle/foreignKeys/set", { vehicleId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: nextKey }, { headers: writeFlagsToHeaders(flags) });
    return flags.dryRun ? { dryRun: true, would: result, server } : result;
}
export const runVehicleFkSet = (client, vehicleId, input, flags) => writeVehicleFk(client, vehicleId, input, input.key.trim(), flags);
export const runVehicleFkRemove = (client, vehicleId, input, flags) => writeVehicleFk(client, vehicleId, input, "", flags);
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