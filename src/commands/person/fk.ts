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
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, unwrapRows, type ListEnvelope } from "../../api/envelopes.js";
import { errorMessage } from "../../api/errors.js";
import { readJsonInput } from "../../api/parseBody.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";
import { failWith, writeJson } from "../../output/json.js";
import { addOwnerOption, parseId } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import {
  fetchFkSources,
  normKey,
  pickFkSource,
  registerFkSourcesLeaf,
  resolveOwner,
  sourceNameOf,
  type FkSource,
} from "../_shared/foreignKeys.js";
import { resolvePersonRef } from "../notification/index.js";

/** Raw dbo.personForeignKeys row as the backend sends it. */
export interface PersonFkRaw {
  personForeignKeyId: number;
  foreignKey: string;
  foreignKeySourceId: number;
  foreignKeyText: string | null;
  isDisabled: boolean | 0 | 1;
  entryTime?: string;
}

export interface PersonFkRow {
  personForeignKeyId: number;
  key: string;
  source: string | null;
  sourceId: number;
  text: string | null;
  isDisabled: boolean;
  entryTime: string | null;
}

export type FkAction = "inserted" | "updated" | "unchanged";

interface SaveBody {
  personForeignKeyId: number | null;
  foreignKey: string;
  foreignKeySourceId: number;
  foreignKeyText: string | null;
  isDisabled: boolean;
}

export interface PersonFkSetResult {
  personId: number;
  ownerAsiakasId: number;
  source: string;
  sourceId: number;
  key: string;
  action: FkAction;
  /** null after an insert — the proc does not return the new id. */
  personForeignKeyId: number | null;
}

async function fetchPersonFks(client: ApiClient, personId: number, owner: number): Promise<PersonFkRaw[]> {
  return unwrapRows(await client.get(`/api/person/getForeignKeys/${personId}/${owner}`)) as unknown as PersonFkRaw[];
}

const savePath = (personId: number, owner: number): string => `/api/person/saveForeignKey/${personId}/${owner}`;

/**
 * Pure planner shared by `set` and `import`: which row (if any) already holds
 * this key on this source, and what body (if any) to POST. `text` undefined =
 * keep the stored label on update, null on insert.
 */
export function planPersonFkSet(
  existing: PersonFkRaw[],
  sourceId: number,
  key: string,
  text: string | undefined,
  disabled: boolean
): { action: FkAction; row: PersonFkRaw | null; body: SaveBody | null } {
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

export async function runPersonFkList(client: ApiClient, person: string, owner?: number): Promise<ListEnvelope<PersonFkRow>> {
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

export interface PersonFkSetInput {
  source: string;
  key: string;
  text?: string;
  disabled?: boolean;
  owner?: number;
}

/** Plan + (unless unchanged / dry-run) POST one key for one person. */
async function applyPersonFkSet(
  client: ApiClient,
  personId: number,
  owner: number,
  source: FkSource,
  existing: PersonFkRaw[],
  input: { key: string; text?: string; disabled?: boolean },
  flags: WriteFlags
): Promise<PersonFkSetResult> {
  const plan = planPersonFkSet(existing, source.foreignKeySourceId, input.key, input.text, input.disabled ?? false);
  const result: PersonFkSetResult = {
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

export async function runPersonFkSet(
  client: ApiClient,
  person: string,
  input: PersonFkSetInput,
  flags: WriteFlags
): Promise<PersonFkSetResult | { dryRun: true; would: PersonFkSetResult }> {
  const owner = resolveOwner(client, input.owner);
  const personId = await resolvePersonRef(client, person);
  const [sources, existing] = await Promise.all([fetchFkSources(client, owner), fetchPersonFks(client, personId, owner)]);
  const source = pickFkSource(sources, input.source, owner);
  const result = await applyPersonFkSet(client, personId, owner, source, existing, input, flags);
  return flags.dryRun ? { dryRun: true, would: result } : result;
}

export interface PersonFkRemoveResult {
  action: "removed";
  personId: number;
  ownerAsiakasId: number;
  personForeignKeyId: number;
  key: string;
  source: string | null;
  sourceId: number;
}

export async function runPersonFkRemove(
  client: ApiClient,
  person: string,
  idStr: string,
  opts: { owner?: number },
  flags: WriteFlags
): Promise<PersonFkRemoveResult | { dryRun: true; would: PersonFkRemoveResult }> {
  const id = parseId(idStr, "personForeignKeyId");
  const owner = resolveOwner(client, opts.owner);
  const personId = await resolvePersonRef(client, person);
  const [sources, existing] = await Promise.all([fetchFkSources(client, owner), fetchPersonFks(client, personId, owner)]);
  const row = existing.find((r) => Number(r.personForeignKeyId) === id);
  if (!row) {
    failWith(`personForeignKeyId ${id} is not on person ${personId} for owner ${owner} — see \`ib person fk list ${personId} --owner ${owner}\``, 5);
  }
  const result: PersonFkRemoveResult = {
    action: "removed",
    personId,
    ownerAsiakasId: owner,
    personForeignKeyId: id,
    key: row.foreignKey,
    source: sourceNameOf(sources, Number(row.foreignKeySourceId)),
    sourceId: Number(row.foreignKeySourceId),
  };
  if (flags.dryRun) return { dryRun: true, would: result };
  // foreignKeySourceId -1 + id is the proc's DELETE branch; the other fields ride along unused.
  await client.post(
    savePath(personId, owner),
    { personForeignKeyId: id, foreignKey: row.foreignKey, foreignKeySourceId: -1, foreignKeyText: row.foreignKeyText ?? null, isDisabled: Boolean(row.isDisabled) },
    { headers: writeFlagsToHeaders(flags) }
  );
  return result;
}

export interface PersonFkImportRow {
  personId: number | null;
  key: string | null;
  ok: boolean;
  action?: FkAction;
  error?: string;
}

export interface PersonFkImportResult {
  dryRun?: true;
  results: PersonFkImportRow[];
  ok: number;
  failed: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Batch `set`: `[{ personId, key, source?, text?, disabled? }]`. Numeric
 * personId only (no batch name resolution — Betomik's placeholder drivers
 * share names). ONE GET per person, then its rows in input order; a key
 * inserted earlier in the same run is seen by later rows for that person, so
 * a duplicate within the file reads `unchanged` instead of doubling.
 */
export async function runPersonFkImport(
  client: ApiClient,
  entries: unknown[],
  opts: { source?: string; owner?: number },
  flags: WriteFlags
): Promise<PersonFkImportResult> {
  const owner = resolveOwner(client, opts.owner);
  const sources = await fetchFkSources(client, owner);
  const defaultSource = opts.source ? pickFkSource(sources, opts.source, owner) : null;

  type Parsed = { i: number; personId: number; key: string; source: FkSource; text?: string; disabled: boolean };
  const results: PersonFkImportRow[] = new Array(entries.length);
  const byPerson = new Map<number, Parsed[]>();
  entries.forEach((raw, i) => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const personId = Number.isSafeInteger(e.personId) && Number(e.personId) > 0 ? Number(e.personId) : null;
    const key = typeof e.key === "string" && e.key.trim() ? e.key : null;
    const fail = (error: string) => { results[i] = { personId, key, ok: false, error }; };
    if (personId === null) return fail("personId must be a positive integer");
    if (key === null) return fail("key must be a non-empty string");
    let source = defaultSource;
    try {
      if (e.source !== undefined && e.source !== null) source = pickFkSource(sources, String(e.source), owner);
    } catch (err) {
      return fail(errorMessage(err));
    }
    if (!source) return fail("no source: pass --source <name|id> or a per-row `source`");
    const list = byPerson.get(personId) ?? [];
    list.push({ i, personId, key, source, text: typeof e.text === "string" ? e.text : undefined, disabled: e.disabled === true });
    byPerson.set(personId, list);
  });

  for (const [personId, rows] of byPerson) {
    let existing: PersonFkRaw[];
    try {
      existing = await fetchPersonFks(client, personId, owner);
    } catch (err) {
      for (const r of rows) results[r.i] = { personId, key: r.key, ok: false, error: errorMessage(err) };
      continue;
    }
    for (const r of rows) {
      try {
        const res = await applyPersonFkSet(client, personId, owner, r.source, existing, r, flags);
        if (res.action === "inserted") {
          existing.push({ personForeignKeyId: 0, foreignKey: r.key, foreignKeySourceId: r.source.foreignKeySourceId, foreignKeyText: r.text ?? null, isDisabled: r.disabled });
        } else if (res.action === "updated") {
          const row = existing.find((x) => x.personForeignKeyId === res.personForeignKeyId);
          if (row) { row.isDisabled = r.disabled; if (r.text !== undefined) row.foreignKeyText = r.text; }
        }
        results[r.i] = { personId, key: r.key, ok: true, action: res.action };
      } catch (err) {
        results[r.i] = { personId, key: r.key, ok: false, error: errorMessage(err) };
      }
    }
  }

  const count = (action: FkAction) => results.filter((r) => r.ok && r.action === action).length;
  return {
    ...(flags.dryRun ? { dryRun: true as const } : {}),
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    inserted: count("inserted"),
    updated: count("updated"),
    unchanged: count("unchanged"),
  };
}

export function registerPersonFkCommands(person: Command, getClient: () => Promise<ApiClient>): void {
  const fk = person.command("fk").description("Manage a person's foreign keys (external ids / nicknames per source)");

  registerFkSourcesLeaf(fk, getClient);

  addOwnerOption(fk.command("list <person>")).action(
    jsonAction(getClient, (client, personRef: string, opts: { owner?: number }) => runPersonFkList(client, personRef, opts.owner))
  );

  addWriteFlagsToCommand(
    addOwnerOption(
      fk.command("set <person>")
        .requiredOption("--source <ref>")
        .requiredOption("--key <text>")
        .option("--text <label>")
        .option("--disabled")
    )
  ).action(
    guarded(async (personRef: string, opts: WriteFlags & PersonFkSetInput) => {
      writeJson(await runPersonFkSet(await getClient(), personRef, opts, opts));
    })
  );

  addWriteFlagsToCommand(addOwnerOption(fk.command("remove <person> <personForeignKeyId>"))).action(
    guarded(async (personRef: string, idStr: string, opts: WriteFlags & { owner?: number }) => {
      writeJson(await runPersonFkRemove(await getClient(), personRef, idStr, opts, opts));
    })
  );

  addWriteFlagsToCommand(addOwnerOption(fk.command("import <file>").option("--source <ref>"))).action(
    guarded(async (file: string, opts: WriteFlags & { source?: string; owner?: number }) => {
      let arr: unknown;
      try { arr = readJsonInput(file); } catch { failWith("import: file is not valid JSON", 4); }
      if (!Array.isArray(arr)) failWith("import: JSON root must be an array of { personId, key, source?, text?, disabled? }", 4);
      writeJson(await runPersonFkImport(await getClient(), arr, opts, opts));
    })
  );
}
