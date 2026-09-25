import { listEnvelope, unwrapRows } from "../../api/envelopes.js";
import { errorMessage } from "../../api/errors.js";
import { readJsonInput } from "../../api/parseBody.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { failWith, writeJson } from "../../output/json.js";
import { addAsiakasTargetOption, addOwnerOption, parseId, resolveAsiakasTarget } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { dryRunOr, fetchFkSources, normKey, pickFkSource, registerFkSourcesLeaf, resolveFkSource, resolveOwner, } from "../_shared/foreignKeys.js";
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
        return dryRunOr(flags, result);
    if (result.action !== "unchanged") {
        // The handler answers HTTP 200 { success:false, error } on a SQL failure
        // (e.g. the (foreignKey, foreignAsiakasId) unique index) — surface it as exit 6.
        const res = await client.post("/api/foreignKey/customer", { asiakasId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key, ownerAsiakasId: owner }, { headers: writeFlagsToHeaders(flags) });
        if (res && res.success === false)
            failWith(`customer foreign key write failed: ${res.error ?? "unknown error"}`, 6);
    }
    return result;
}
/**
 * Append one key (POST /api/foreignKey/customer/add). A trimmed,
 * case-insensitive match on the same source is `unchanged` and sends nothing;
 * the server settles the rest (unchanged when this customer holds the key on
 * another source, 409 when another customer holds it).
 */
async function applyCustomerFkAdd(client, asiakasId, owner, source, existing, rawKey, flags) {
    const key = rawKey.trim();
    const base = { asiakasId, ownerAsiakasId: owner, source: source.name, sourceId: source.foreignKeySourceId };
    const row = existing.find((r) => r.sourceId === source.foreignKeySourceId && normKey(r.key) === normKey(key));
    if (row)
        return { ...base, key: row.key, action: "unchanged", asiakasForeignKeyId: row.asiakasForeignKeyId };
    if (flags.dryRun)
        return { ...base, key, action: "inserted", asiakasForeignKeyId: null };
    const res = await client.post("/api/foreignKey/customer/add", { asiakasId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key, ownerAsiakasId: owner }, { headers: writeFlagsToHeaders(flags) });
    return {
        ...base,
        key,
        action: res?.action === "unchanged" ? "unchanged" : "inserted",
        asiakasForeignKeyId: res?.asiakasForeignKeyId == null ? null : Number(res.asiakasForeignKeyId),
    };
}
export async function runCustomerFkAdd(client, asiakasId, input, flags) {
    const owner = resolveOwner(client, input.owner);
    if (!input.key.trim())
        failWith("--key must not be blank", 4);
    const [source, existing] = await Promise.all([resolveFkSource(client, owner, input.source), fetchCustomerFks(client, asiakasId, owner)]);
    return dryRunOr(flags, await applyCustomerFkAdd(client, asiakasId, owner, source, existing, input.key, flags));
}
/**
 * Batch `add` (fb#1719): `[{ asiakasId, key, source? }]`. In-file repeats
 * (same customer + source + key) read `unchanged` before any write; then ONE
 * GET per customer and each row appended in input order. A failing row (bad
 * shape, unknown source, 409) fails only itself.
 */
export async function runCustomerFkImport(client, entries, opts, flags) {
    const owner = resolveOwner(client, opts.owner);
    const sources = await fetchFkSources(client, owner);
    const defaultSource = opts.source ? pickFkSource(sources, opts.source, owner) : null;
    const results = new Array(entries.length);
    const byCustomer = new Map();
    entries.forEach((raw, i) => {
        const e = (raw && typeof raw === "object" ? raw : {});
        const asiakasId = Number.isSafeInteger(e.asiakasId) && Number(e.asiakasId) > 0 ? Number(e.asiakasId) : null;
        const key = typeof e.key === "string" && e.key.trim() ? e.key.trim() : null;
        const fail = (error) => { results[i] = { asiakasId, key, ok: false, error }; };
        if (asiakasId === null)
            return fail("asiakasId must be a positive integer");
        if (key === null)
            return fail("key must be a non-empty string");
        let source = defaultSource;
        try {
            if (e.source !== undefined && e.source !== null)
                source = pickFkSource(sources, String(e.source), owner);
        }
        catch (err) {
            return fail(errorMessage(err));
        }
        if (!source)
            return fail("no source: pass --source <name|id> or a per-row `source`");
        const list = byCustomer.get(asiakasId) ?? [];
        if (list.some((p) => p.source === source && normKey(p.key) === normKey(key))) {
            results[i] = { asiakasId, key, ok: true, action: "unchanged" };
            return;
        }
        list.push({ i, key, source });
        byCustomer.set(asiakasId, list);
    });
    for (const [asiakasId, rows] of byCustomer) {
        let existing;
        try {
            existing = await fetchCustomerFks(client, asiakasId, owner);
        }
        catch (err) {
            for (const r of rows)
                results[r.i] = { asiakasId, key: r.key, ok: false, error: errorMessage(err) };
            continue;
        }
        for (const r of rows) {
            try {
                const res = await applyCustomerFkAdd(client, asiakasId, owner, r.source, existing, r.key, flags);
                results[r.i] = { asiakasId, key: r.key, ok: true, action: res.action };
            }
            catch (err) {
                results[r.i] = { asiakasId, key: r.key, ok: false, error: errorMessage(err) };
            }
        }
    }
    const count = (action) => results.filter((r) => r.ok && r.action === action).length;
    return {
        ...(flags.dryRun ? { dryRun: true } : {}),
        results,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        inserted: count("inserted"),
        unchanged: count("unchanged"),
    };
}
/**
 * The row to remove: by <asiakasForeignKeyId>, or by --key (trimmed,
 * case-insensitive; --source narrows when one spelling sits on several
 * sources) so one alias can go without looking its id up first (fb#1975).
 */
function pickRowToRemove(rows, idStr, opts, where) {
    if ((idStr === undefined) === (opts.key === undefined)) {
        failWith("pass exactly one of <asiakasForeignKeyId> or --key <text>", 4);
    }
    if (idStr !== undefined) {
        if (opts.source)
            failWith("--source only narrows --key; drop it when removing by id", 4);
        const id = parseId(idStr, "asiakasForeignKeyId");
        const row = rows.find((r) => r.asiakasForeignKeyId === id);
        if (!row)
            failWith(`asiakasForeignKeyId ${id} is not on ${where}`, 5);
        return row;
    }
    const hits = rows.filter((r) => normKey(r.key) === normKey(opts.key) && (!opts.source || r.sourceId === opts.source.foreignKeySourceId));
    if (hits.length === 0)
        failWith(`key "${opts.key}"${opts.source ? ` on source ${opts.source.name}` : ""} is not on ${where}`, 5);
    if (hits.length > 1) {
        failWith(`key "${opts.key}" matches ${hits.length} rows (sources: ${hits.map((h) => h.source).join(", ")}) — narrow with --source, or remove by id`, 4);
    }
    return hits[0];
}
export async function runCustomerFkRemove(client, asiakasId, idStr, opts, flags) {
    const owner = resolveOwner(client, opts.owner);
    const [rows, source] = await Promise.all([
        fetchCustomerFks(client, asiakasId, owner),
        opts.source === undefined ? undefined : resolveFkSource(client, owner, opts.source),
    ]);
    const where = `customer ${asiakasId} for owner ${owner} — see \`ib customer fk list ${asiakasId} --owner ${owner}\``;
    const row = pickRowToRemove(rows, idStr, { key: opts.key, source }, where);
    const id = row.asiakasForeignKeyId;
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
        return dryRunOr(flags, result);
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
    addWriteFlagsToCommand(addOwnerOption(addAsiakasTargetOption(fk.command("add [asiakasId]")).requiredOption("--source <ref>").requiredOption("--key <text>"))).action(guarded(async (idStr, opts) => {
        writeJson(await runCustomerFkAdd(await getClient(), resolveAsiakasTarget(idStr, opts.asiakas), opts, opts));
    }));
    // <asiakasId> stays required and positional (no --asiakas alias): the
    // optional id after it would make an omitted customer id ambiguous.
    addWriteFlagsToCommand(addOwnerOption(fk.command("remove <asiakasId> [asiakasForeignKeyId]").option("--key <text>").option("--source <ref>"))).action(guarded(async (idStr, fkId, opts) => {
        writeJson(await runCustomerFkRemove(await getClient(), parseId(idStr, "asiakasId"), fkId, opts, opts));
    }));
    addWriteFlagsToCommand(addOwnerOption(fk.command("import <file>").option("--source <ref>"))).action(guarded(async (file, opts) => {
        let arr;
        try {
            arr = readJsonInput(file);
        }
        catch {
            failWith("import: file is not valid JSON", 4);
        }
        if (!Array.isArray(arr))
            failWith("import: JSON root must be an array of { asiakasId, key, source? }", 4);
        writeJson(await runCustomerFkImport(await getClient(), arr, opts, opts));
    }));
}
//# sourceMappingURL=fk.js.map