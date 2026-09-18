/**
 * `ib person fk` — person foreign keys (dbo.personForeignKeys), fb#1683.
 *
 * Many keys per (person, source): the Betomik order-book sync resolves sheet
 * driver names through rows on source `betomik-orderbook`, owner 27, one row
 * per nickname. The backend upsert (`person_saveForeignKey`) is BY ID and
 * never dedupes an INSERT, and its DELETE is owner-blind — so `set` matches
 * the existing rows client-side (trim + case-insensitive, the matcher's rule)
 * before it writes, and `remove` refuses an id that is not on the person.
 * Neither route honours X-Dry-Run, so --dry-run resolves client-side.
 */
import { Option } from "commander";
import { listEnvelope, unwrapRows } from "../../api/envelopes.js";
import { errorMessage } from "../../api/errors.js";
import { readJsonInput } from "../../api/parseBody.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { failWith, writeJson } from "../../output/json.js";
import { addOwnerOption, intFlag, parseId } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { dryRunOr, fetchFkSources, normKey, pickFkSource, registerFkSourcesLeaf, resolveFkSource, resolveOwner, sourceNameOf, } from "../_shared/foreignKeys.js";
import { resolvePersonRef } from "../notification/index.js";
async function fetchPersonFks(client, personId, owner) {
    return unwrapRows(await client.get(`/api/person/getForeignKeys/${personId}/${owner}`));
}
const savePath = (personId, owner) => `/api/person/saveForeignKey/${personId}/${owner}`;
/**
 * Pure planner shared by `set` and `import`: which row (if any) already holds
 * this key on this source, and what body (if any) to POST. `text` undefined =
 * keep the stored label on update, null on insert.
 */
export function planPersonFkSet(existing, sourceId, key, text, disabled) {
    const row = existing.find((r) => Number(r.foreignKeySourceId) === sourceId && normKey(r.foreignKey) === normKey(key)) ?? null;
    const foreignKeyText = text === undefined ? (row?.foreignKeyText ?? null) : text;
    if (row && Boolean(row.isDisabled) === disabled && (row.foreignKeyText ?? null) === foreignKeyText) {
        return { action: "unchanged", row, body: null };
    }
    return {
        action: row ? "updated" : "inserted",
        row,
        body: {
            personForeignKeyId: row?.personForeignKeyId ?? null,
            foreignKey: row?.foreignKey ?? key.trim(),
            foreignKeySourceId: sourceId,
            foreignKeyText,
            isDisabled: disabled,
        },
    };
}
export async function runPersonFkList(client, person, owner) {
    const ownerId = resolveOwner(client, owner);
    const personId = await resolvePersonRef(client, person);
    const [rows, sources] = await Promise.all([fetchPersonFks(client, personId, ownerId), fetchFkSources(client, ownerId)]);
    const items = rows.map((r) => ({
        personForeignKeyId: Number(r.personForeignKeyId),
        key: r.foreignKey,
        source: sourceNameOf(sources, Number(r.foreignKeySourceId)),
        sourceId: Number(r.foreignKeySourceId),
        text: r.foreignKeyText ?? null,
        isDisabled: Boolean(r.isDisabled),
        entryTime: r.entryTime ?? null,
    }));
    return listEnvelope(items, { truncated: false });
}
async function fetchPersonFksBySource(client, owner, sourceId) {
    return unwrapRows(await client.get(`/api/person/getForeignKeysBySource/${owner}/${sourceId}`));
}
/**
 * Every taught nickname of ONE source for an owner, across ALL persons
 * (fb#1740) — the aggregate counterpart to {@link runPersonFkList}, which is
 * scoped to one person. Reviewing the taught vocabulary otherwise required a
 * raw dbo query via `ib dev schema query`.
 */
export async function runPersonFkListSource(client, sourceRef, owner) {
    const ownerId = resolveOwner(client, owner);
    const source = await resolveFkSource(client, ownerId, sourceRef);
    const rows = await fetchPersonFksBySource(client, ownerId, source.foreignKeySourceId);
    const items = rows.map((r) => ({
        personForeignKeyId: Number(r.personForeignKeyId),
        personId: Number(r.personId),
        personName: [r.personFirstName, r.personLastName].filter(Boolean).join(" "),
        key: r.foreignKey,
        text: r.foreignKeyText ?? null,
        isDisabled: Boolean(r.isDisabled),
        entryTime: r.entryTime ?? null,
    }));
    return listEnvelope(items, { truncated: false });
}
/** Plan + (unless unchanged / dry-run) POST one key for one person. */
async function applyPersonFkSet(client, personId, owner, source, existing, input, flags) {
    const plan = planPersonFkSet(existing, source.foreignKeySourceId, input.key, input.text, input.disabled ?? false);
    const result = {
        personId,
        ownerAsiakasId: owner,
        source: source.name,
        sourceId: source.foreignKeySourceId,
        key: plan.row?.foreignKey ?? input.key.trim(),
        action: plan.action,
        personForeignKeyId: plan.row?.personForeignKeyId ?? null,
    };
    if (plan.body && !flags.dryRun) {
        await client.post(savePath(personId, owner), plan.body, { headers: writeFlagsToHeaders(flags) });
    }
    return result;
}
export async function runPersonFkSet(client, person, input, flags) {
    const owner = resolveOwner(client, input.owner);
    const personId = await resolvePersonRef(client, person);
    const [sources, existing] = await Promise.all([fetchFkSources(client, owner), fetchPersonFks(client, personId, owner)]);
    const source = pickFkSource(sources, input.source, owner);
    return dryRunOr(flags, await applyPersonFkSet(client, personId, owner, source, existing, input, flags));
}
export async function runPersonFkRemove(client, person, idStr, opts, flags) {
    const id = parseId(idStr, "personForeignKeyId");
    const owner = resolveOwner(client, opts.owner);
    const personId = await resolvePersonRef(client, person);
    const [sources, existing] = await Promise.all([fetchFkSources(client, owner), fetchPersonFks(client, personId, owner)]);
    const row = existing.find((r) => Number(r.personForeignKeyId) === id);
    if (!row) {
        failWith(`personForeignKeyId ${id} is not on person ${personId} for owner ${owner} — see \`ib person fk list ${personId} --owner ${owner}\``, 5);
    }
    const result = {
        action: "removed",
        personId,
        ownerAsiakasId: owner,
        personForeignKeyId: id,
        key: row.foreignKey,
        source: sourceNameOf(sources, Number(row.foreignKeySourceId)),
        sourceId: Number(row.foreignKeySourceId),
    };
    if (flags.dryRun)
        return dryRunOr(flags, result);
    // foreignKeySourceId -1 + id is the proc's DELETE branch; the other fields ride along unused.
    await client.post(savePath(personId, owner), { personForeignKeyId: id, foreignKey: row.foreignKey, foreignKeySourceId: -1, foreignKeyText: row.foreignKeyText ?? null, isDisabled: Boolean(row.isDisabled) }, { headers: writeFlagsToHeaders(flags) });
    return result;
}
/**
 * Batch `set`: `[{ personId, key, source?, text?, disabled? }]`. Numeric
 * personId only (no batch name resolution — Betomik's placeholder drivers
 * share names). Duplicates WITHIN the file (same person + source + key) are
 * settled before any write: an identical repeat reads `unchanged`, a repeat
 * with a different text/disabled fails its own row — the backend cannot
 * update a row this run just inserted (the proc returns no id). Then ONE GET
 * per person and its rows in input order.
 */
export async function runPersonFkImport(client, entries, opts, flags) {
    const owner = resolveOwner(client, opts.owner);
    const sources = await fetchFkSources(client, owner);
    const defaultSource = opts.source ? pickFkSource(sources, opts.source, owner) : null;
    const results = new Array(entries.length);
    const byPerson = new Map();
    entries.forEach((raw, i) => {
        const e = (raw && typeof raw === "object" ? raw : {});
        const personId = Number.isSafeInteger(e.personId) && Number(e.personId) > 0 ? Number(e.personId) : null;
        const key = typeof e.key === "string" && e.key.trim() ? e.key : null;
        const fail = (error) => { results[i] = { personId, key, ok: false, error }; };
        if (personId === null)
            return fail("personId must be a positive integer");
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
        const list = byPerson.get(personId) ?? [];
        const row = { i, personId, key, source, text: typeof e.text === "string" ? e.text : undefined, disabled: e.disabled === true };
        const dup = list.find((p) => p.source === source && normKey(p.key) === normKey(key));
        if (dup) {
            if (dup.text === row.text && dup.disabled === row.disabled)
                results[i] = { personId, key, ok: true, action: "unchanged" };
            else
                fail(`duplicate of row ${dup.i + 1} (same source + key) with a different text/disabled — keep one`);
            return;
        }
        list.push(row);
        byPerson.set(personId, list);
    });
    for (const [personId, rows] of byPerson) {
        let existing;
        try {
            existing = await fetchPersonFks(client, personId, owner);
        }
        catch (err) {
            for (const r of rows)
                results[r.i] = { personId, key: r.key, ok: false, error: errorMessage(err) };
            continue;
        }
        for (const r of rows) {
            try {
                const res = await applyPersonFkSet(client, personId, owner, r.source, existing, r, flags);
                results[r.i] = { personId, key: r.key, ok: true, action: res.action };
            }
            catch (err) {
                results[r.i] = { personId, key: r.key, ok: false, error: errorMessage(err) };
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
        updated: count("updated"),
        unchanged: count("unchanged"),
    };
}
/**
 * Fold the hidden `--asiakas` alias into `--owner` (fb#1732). Every other
 * person subcommand spells the tenant scope `--asiakas`, so a caller who
 * learned the domain from `person list/get/search` reached for it here and got
 * exit 4. Commander has no true option aliasing — `--asiakas` lands on its own
 * key — so the fold runs before the action reads `opts.owner`. Hidden: the
 * spec documents only `--owner` (the fb#429 attachment shape).
 */
export function foldOwnerAlias(opts) {
    if (opts.asiakas === undefined)
        return;
    if (opts.owner !== undefined && opts.owner !== opts.asiakas) {
        failWith(`--asiakas is an alias for --owner — they disagree (${opts.asiakas} vs ${opts.owner}); pass only one`, 4);
    }
    opts.owner = opts.asiakas;
    delete opts.asiakas;
}
function addOwnerWithAlias(cmd) {
    return addOwnerOption(cmd).addOption(new Option("--asiakas <id>").argParser(intFlag("--asiakas")).hideHelp());
}
export function registerPersonFkCommands(person, getClient) {
    const fk = person.command("fk").description("Manage a person's foreign keys (external ids / nicknames per source)");
    registerFkSourcesLeaf(fk, getClient);
    addOwnerWithAlias(fk.command("list <person>")).action(jsonAction(getClient, (client, personRef, opts) => {
        foldOwnerAlias(opts);
        return runPersonFkList(client, personRef, opts.owner);
    }));
    addOwnerWithAlias(fk.command("list-source <source>")).action(jsonAction(getClient, (client, source, opts) => {
        foldOwnerAlias(opts);
        return runPersonFkListSource(client, source, opts.owner);
    }));
    addWriteFlagsToCommand(addOwnerWithAlias(fk.command("set <person>")
        .requiredOption("--source <ref>")
        .requiredOption("--key <text>")
        .option("--text <label>")
        .option("--disabled"))).action(guarded(async (personRef, opts) => {
        foldOwnerAlias(opts);
        writeJson(await runPersonFkSet(await getClient(), personRef, opts, opts));
    }));
    addWriteFlagsToCommand(addOwnerWithAlias(fk.command("remove <person> <personForeignKeyId>"))).action(guarded(async (personRef, idStr, opts) => {
        foldOwnerAlias(opts);
        writeJson(await runPersonFkRemove(await getClient(), personRef, idStr, opts, opts));
    }));
    addWriteFlagsToCommand(addOwnerWithAlias(fk.command("import <file>").option("--source <ref>"))).action(guarded(async (file, opts) => {
        foldOwnerAlias(opts);
        let arr;
        try {
            arr = readJsonInput(file);
        }
        catch {
            failWith("import: file is not valid JSON", 4);
        }
        if (!Array.isArray(arr))
            failWith("import: JSON root must be an array of { personId, key, source?, text?, disabled? }", 4);
        writeJson(await runPersonFkImport(await getClient(), arr, opts, opts));
    }));
}
//# sourceMappingURL=fk.js.map