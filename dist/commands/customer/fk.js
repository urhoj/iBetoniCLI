import { listEnvelope, unwrapRows } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { failWith, writeJson } from "../../output/json.js";
import { addAsiakasTargetOption, addOwnerOption, parseId, resolveAsiakasTarget } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { registerFkSourcesLeaf, resolveFkSource, resolveOwner } from "../_shared/foreignKeys.js";
async function fetchCustomerFks(client, asiakasId, owner) {
    const rows = unwrapRows(await client.get(`/api/foreignKey/customer/${asiakasId}/${owner}`));
    return rows.map((r) => ({
        asiakasForeignKeyId: Number(r.asiakasForeignKeyId),
        key: String(r.foreignKey),
        source: String(r.foreignKeySourceName ?? ""),
        sourceId: Number(r.foreignKeySourceId),
        entryTime: r.entryTime == null ? null : String(r.entryTime),
    }));
}
export async function runCustomerFkList(client, asiakasId, owner) {
    return listEnvelope(await fetchCustomerFks(client, asiakasId, resolveOwner(client, owner)), { truncated: false });
}
export async function runCustomerFkSet(client, asiakasId, input, flags) {
    const owner = resolveOwner(client, input.owner);
    const [source, existing] = await Promise.all([resolveFkSource(client, owner, input.source), fetchCustomerFks(client, asiakasId, owner)]);
    const row = existing.find((r) => r.sourceId === source.foreignKeySourceId);
    const key = input.key.trim();
    const result = {
        asiakasId,
        ownerAsiakasId: owner,
        source: source.name,
        sourceId: source.foreignKeySourceId,
        key,
        action: !row ? "inserted" : row.key === key ? "unchanged" : "updated",
    };
    if (flags.dryRun)
        return { dryRun: true, would: result };
    if (result.action !== "unchanged") {
        // The handler answers HTTP 200 { success:false, error } on a SQL failure
        // (e.g. the (foreignKey, foreignAsiakasId) unique index) — surface it as exit 6.
        const res = await client.post("/api/foreignKey/customer", { asiakasId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key, ownerAsiakasId: owner }, { headers: writeFlagsToHeaders(flags) });
        if (res && res.success === false)
            failWith(`customer foreign key write failed: ${res.error ?? "unknown error"}`, 6);
    }
    return result;
}
export async function runCustomerFkRemove(client, asiakasId, idStr, opts, flags) {
    const id = parseId(idStr, "asiakasForeignKeyId");
    const owner = resolveOwner(client, opts.owner);
    const row = (await fetchCustomerFks(client, asiakasId, owner)).find((r) => r.asiakasForeignKeyId === id);
    if (!row) {
        failWith(`asiakasForeignKeyId ${id} is not on customer ${asiakasId} for owner ${owner} — see \`ib customer fk list ${asiakasId} --owner ${owner}\``, 5);
    }
    const result = {
        action: "removed",
        asiakasId,
        ownerAsiakasId: owner,
        asiakasForeignKeyId: id,
        key: row.key,
        source: row.source,
        sourceId: row.sourceId,
    };
    if (flags.dryRun)
        return { dryRun: true, would: result };
    await client.delete(`/api/foreignKey/customer/${id}/${owner}`, { headers: writeFlagsToHeaders(flags) });
    return result;
}
export function registerCustomerFkCommands(customer, getClient) {
    const fk = customer.command("fk").description("Manage a customer's foreign keys (external ids per source)");
    registerFkSourcesLeaf(fk, getClient);
    addOwnerOption(addAsiakasTargetOption(fk.command("list [asiakasId]"))).action(jsonAction(getClient, (client, idStr, opts) => runCustomerFkList(client, resolveAsiakasTarget(idStr, opts.asiakas), opts.owner)));
    addWriteFlagsToCommand(addOwnerOption(addAsiakasTargetOption(fk.command("set [asiakasId]")).requiredOption("--source <ref>").requiredOption("--key <text>"))).action(guarded(async (idStr, opts) => {
        writeJson(await runCustomerFkSet(await getClient(), resolveAsiakasTarget(idStr, opts.asiakas), opts, opts));
    }));
    // Two required positionals, no --asiakas alias: an optional positional ahead
    // of a required one is ambiguous to parse (which id did the caller omit?).
    addWriteFlagsToCommand(addOwnerOption(fk.command("remove <asiakasId> <asiakasForeignKeyId>"))).action(guarded(async (idStr, fkId, opts) => {
        writeJson(await runCustomerFkRemove(await getClient(), parseId(idStr, "asiakasId"), fkId, opts, opts));
    }));
}
//# sourceMappingURL=fk.js.map