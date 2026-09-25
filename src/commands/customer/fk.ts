/**
 * `ib customer fk` — customer foreign keys (dbo.asiakasForeignKeys), fb#1683.
 *
 * Two write shapes. `set` is the backend's one-key-per-(customer, source,
 * owner) upsert — right for an accounting-system customer number. `add` /
 * `import` APPEND (fb#1975, fb#1719): an alias source such as
 * betomik-orderbook holds one row per spelling, and replacing one re-arms a
 * duplicate customer on the importer's next pass. IX_asiakasForeignKeys keeps
 * a key unique per owner across ALL sources, so `add` 409s when another
 * customer holds it. The routes honour no X-Dry-Run, so --dry-run resolves
 * client-side; the DELETE is owner-scoped server-side and the row is still
 * checked against the customer's rows first, so a wrong id exits 5 instead of
 * a silent 0-row delete.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, unwrapRows, type ListEnvelope } from "../../api/envelopes.js";
import { errorMessage } from "../../api/errors.js";
import { readJsonInput } from "../../api/parseBody.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";
import { failWith, writeJson } from "../../output/json.js";
import { addAsiakasTargetOption, addOwnerOption, parseId, resolveAsiakasTarget } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import {
  dryRunOr,
  fetchFkSources,
  normKey,
  pickFkSource,
  registerFkSourcesLeaf,
  resolveFkSource,
  resolveOwner,
  type FkSource,
  type MaybeDryRun,
} from "../_shared/foreignKeys.js";

export interface CustomerFkRow {
  asiakasForeignKeyId: number;
  key: string;
  source: string;
  sourceId: number;
  entryTime: string | null;
}

async function fetchCustomerFks(client: ApiClient, asiakasId: number, owner: number): Promise<CustomerFkRow[]> {
  const rows = unwrapRows(await client.get(`/api/foreignKey/customer/${asiakasId}/${owner}`));
  return rows.map((r) => ({
    asiakasForeignKeyId: Number(r.asiakasForeignKeyId),
    key: String(r.foreignKey),
    source: String(r.foreignKeySourceName ?? ""),
    sourceId: Number(r.foreignKeySourceId),
    entryTime: r.entryTime == null ? null : String(r.entryTime),
  }));
}

export async function runCustomerFkList(client: ApiClient, asiakasId: number, owner?: number): Promise<ListEnvelope<CustomerFkRow>> {
  return listEnvelope(await fetchCustomerFks(client, asiakasId, resolveOwner(client, owner)), { truncated: false });
}

export interface CustomerFkSetResult {
  asiakasId: number;
  ownerAsiakasId: number;
  source: string;
  sourceId: number;
  key: string;
  action: "inserted" | "updated" | "unchanged";
}

export async function runCustomerFkSet(
  client: ApiClient,
  asiakasId: number,
  input: { source: string; key: string; owner?: number },
  flags: WriteFlags
): Promise<MaybeDryRun<CustomerFkSetResult>> {
  const owner = resolveOwner(client, input.owner);
  const [source, existing] = await Promise.all([resolveFkSource(client, owner, input.source), fetchCustomerFks(client, asiakasId, owner)]);
  const row = existing.find((r) => r.sourceId === source.foreignKeySourceId);
  const key = input.key.trim();
  const result: CustomerFkSetResult = {
    asiakasId,
    ownerAsiakasId: owner,
    source: source.name,
    sourceId: source.foreignKeySourceId,
    key,
    action: !row ? "inserted" : row.key === key ? "unchanged" : "updated",
  };
  if (flags.dryRun) return dryRunOr(flags, result);
  if (result.action !== "unchanged") {
    // The handler answers HTTP 200 { success:false, error } on a SQL failure
    // (e.g. the (foreignKey, foreignAsiakasId) unique index) — surface it as exit 6.
    const res = await client.post<{ success?: boolean; error?: string }>(
      "/api/foreignKey/customer",
      { asiakasId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key, ownerAsiakasId: owner },
      { headers: writeFlagsToHeaders(flags) }
    );
    if (res && res.success === false) failWith(`customer foreign key write failed: ${res.error ?? "unknown error"}`, 6);
  }
  return result;
}

export interface CustomerFkAddResult {
  asiakasId: number;
  ownerAsiakasId: number;
  source: string;
  sourceId: number;
  key: string;
  action: "inserted" | "unchanged";
  /** null on a dry-run insert — the id exists only once the row does. */
  asiakasForeignKeyId: number | null;
}

/**
 * Append one key (POST /api/foreignKey/customer/add). A trimmed,
 * case-insensitive match on the same source is `unchanged` and sends nothing;
 * the server settles the rest (unchanged when this customer holds the key on
 * another source, 409 when another customer holds it).
 */
async function applyCustomerFkAdd(
  client: ApiClient,
  asiakasId: number,
  owner: number,
  source: FkSource,
  existing: CustomerFkRow[],
  rawKey: string,
  flags: WriteFlags
): Promise<CustomerFkAddResult> {
  const key = rawKey.trim();
  const base = { asiakasId, ownerAsiakasId: owner, source: source.name, sourceId: source.foreignKeySourceId };
  const row = existing.find((r) => r.sourceId === source.foreignKeySourceId && normKey(r.key) === normKey(key));
  if (row) return { ...base, key: row.key, action: "unchanged", asiakasForeignKeyId: row.asiakasForeignKeyId };
  if (flags.dryRun) return { ...base, key, action: "inserted", asiakasForeignKeyId: null };
  const res = await client.post<{ action?: string; asiakasForeignKeyId?: number }>(
    "/api/foreignKey/customer/add",
    { asiakasId, foreignKeySourceId: source.foreignKeySourceId, foreignKey: key, ownerAsiakasId: owner },
    { headers: writeFlagsToHeaders(flags) }
  );
  return {
    ...base,
    key,
    action: res?.action === "unchanged" ? "unchanged" : "inserted",
    asiakasForeignKeyId: res?.asiakasForeignKeyId == null ? null : Number(res.asiakasForeignKeyId),
  };
}

export async function runCustomerFkAdd(
  client: ApiClient,
  asiakasId: number,
  input: { source: string; key: string; owner?: number },
  flags: WriteFlags
): Promise<MaybeDryRun<CustomerFkAddResult>> {
  const owner = resolveOwner(client, input.owner);
  if (!input.key.trim()) failWith("--key must not be blank", 4);
  const [source, existing] = await Promise.all([resolveFkSource(client, owner, input.source), fetchCustomerFks(client, asiakasId, owner)]);
  return dryRunOr(flags, await applyCustomerFkAdd(client, asiakasId, owner, source, existing, input.key, flags));
}

export interface CustomerFkImportRow {
  asiakasId: number | null;
  key: string | null;
  ok: boolean;
  action?: "inserted" | "unchanged";
  error?: string;
}

export interface CustomerFkImportResult {
  dryRun?: true;
  results: CustomerFkImportRow[];
  ok: number;
  failed: number;
  inserted: number;
  unchanged: number;
}

/**
 * Batch `add` (fb#1719): `[{ asiakasId, key, source? }]`. In-file repeats
 * (same customer + source + key) read `unchanged` before any write; then ONE
 * GET per customer and each row appended in input order. A failing row (bad
 * shape, unknown source, 409) fails only itself.
 */
export async function runCustomerFkImport(
  client: ApiClient,
  entries: unknown[],
  opts: { source?: string; owner?: number },
  flags: WriteFlags
): Promise<CustomerFkImportResult> {
  const owner = resolveOwner(client, opts.owner);
  const sources = await fetchFkSources(client, owner);
  const defaultSource = opts.source ? pickFkSource(sources, opts.source, owner) : null;

  type Parsed = { i: number; key: string; source: FkSource };
  const results: CustomerFkImportRow[] = new Array(entries.length);
  const byCustomer = new Map<number, Parsed[]>();
  entries.forEach((raw, i) => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const asiakasId = Number.isSafeInteger(e.asiakasId) && Number(e.asiakasId) > 0 ? Number(e.asiakasId) : null;
    const key = typeof e.key === "string" && e.key.trim() ? e.key.trim() : null;
    const fail = (error: string) => { results[i] = { asiakasId, key, ok: false, error }; };
    if (asiakasId === null) return fail("asiakasId must be a positive integer");
    if (key === null) return fail("key must be a non-empty string");
    let source = defaultSource;
    try {
      if (e.source !== undefined && e.source !== null) source = pickFkSource(sources, String(e.source), owner);
    } catch (err) {
      return fail(errorMessage(err));
    }
    if (!source) return fail("no source: pass --source <name|id> or a per-row `source`");
    const list = byCustomer.get(asiakasId) ?? [];
    if (list.some((p) => p.source === source && normKey(p.key) === normKey(key))) {
      results[i] = { asiakasId, key, ok: true, action: "unchanged" };
      return;
    }
    list.push({ i, key, source });
    byCustomer.set(asiakasId, list);
  });

  for (const [asiakasId, rows] of byCustomer) {
    let existing: CustomerFkRow[];
    try {
      existing = await fetchCustomerFks(client, asiakasId, owner);
    } catch (err) {
      for (const r of rows) results[r.i] = { asiakasId, key: r.key, ok: false, error: errorMessage(err) };
      continue;
    }
    for (const r of rows) {
      try {
        const res = await applyCustomerFkAdd(client, asiakasId, owner, r.source, existing, r.key, flags);
        results[r.i] = { asiakasId, key: r.key, ok: true, action: res.action };
      } catch (err) {
        results[r.i] = { asiakasId, key: r.key, ok: false, error: errorMessage(err) };
      }
    }
  }

  const count = (action: "inserted" | "unchanged") => results.filter((r) => r.ok && r.action === action).length;
  return {
    ...(flags.dryRun ? { dryRun: true as const } : {}),
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    inserted: count("inserted"),
    unchanged: count("unchanged"),
  };
}

export interface CustomerFkRemoveResult {
  action: "removed";
  asiakasId: number;
  ownerAsiakasId: number;
  asiakasForeignKeyId: number;
  key: string;
  source: string;
  sourceId: number;
}

/**
 * The row to remove: by <asiakasForeignKeyId>, or by --key (trimmed,
 * case-insensitive; --source narrows when one spelling sits on several
 * sources) so one alias can go without looking its id up first (fb#1975).
 */
function pickRowToRemove(
  rows: CustomerFkRow[],
  idStr: string | undefined,
  opts: { key?: string; source?: FkSource },
  where: string
): CustomerFkRow {
  if ((idStr === undefined) === (opts.key === undefined)) {
    failWith("pass exactly one of <asiakasForeignKeyId> or --key <text>", 4);
  }
  if (idStr !== undefined) {
    if (opts.source) failWith("--source only narrows --key; drop it when removing by id", 4);
    const id = parseId(idStr, "asiakasForeignKeyId");
    const row = rows.find((r) => r.asiakasForeignKeyId === id);
    if (!row) failWith(`asiakasForeignKeyId ${id} is not on ${where}`, 5);
    return row;
  }
  const hits = rows.filter((r) => normKey(r.key) === normKey(opts.key) && (!opts.source || r.sourceId === opts.source.foreignKeySourceId));
  if (hits.length === 0) failWith(`key "${opts.key}"${opts.source ? ` on source ${opts.source.name}` : ""} is not on ${where}`, 5);
  if (hits.length > 1) {
    failWith(`key "${opts.key}" matches ${hits.length} rows (sources: ${hits.map((h) => h.source).join(", ")}) — narrow with --source, or remove by id`, 4);
  }
  return hits[0];
}

export async function runCustomerFkRemove(
  client: ApiClient,
  asiakasId: number,
  idStr: string | undefined,
  opts: { owner?: number; key?: string; source?: string },
  flags: WriteFlags
): Promise<MaybeDryRun<CustomerFkRemoveResult>> {
  const owner = resolveOwner(client, opts.owner);
  const [rows, source] = await Promise.all([
    fetchCustomerFks(client, asiakasId, owner),
    opts.source === undefined ? undefined : resolveFkSource(client, owner, opts.source),
  ]);
  const where = `customer ${asiakasId} for owner ${owner} — see \`ib customer fk list ${asiakasId} --owner ${owner}\``;
  const row = pickRowToRemove(rows, idStr, { key: opts.key, source }, where);
  const id = row.asiakasForeignKeyId;
  const result: CustomerFkRemoveResult = {
    action: "removed",
    asiakasId,
    ownerAsiakasId: owner,
    asiakasForeignKeyId: id,
    key: row.key,
    source: row.source,
    sourceId: row.sourceId,
  };
  if (flags.dryRun) return dryRunOr(flags, result);
  await client.delete(`/api/foreignKey/customer/${id}/${owner}`, { headers: writeFlagsToHeaders(flags) });
  return result;
}

export function registerCustomerFkCommands(customer: Command, getClient: () => Promise<ApiClient>): void {
  const fk = customer.command("fk").description("Manage a customer's foreign keys (external ids per source)");

  registerFkSourcesLeaf(fk, getClient);

  addOwnerOption(addAsiakasTargetOption(fk.command("list [asiakasId]"))).action(
    jsonAction(getClient, (client, idStr: string | undefined, opts: { asiakas?: number; owner?: number }) =>
      runCustomerFkList(client, resolveAsiakasTarget(idStr, opts.asiakas), opts.owner)
    )
  );

  addWriteFlagsToCommand(
    addOwnerOption(
      addAsiakasTargetOption(fk.command("set [asiakasId]")).requiredOption("--source <ref>").requiredOption("--key <text>")
    )
  ).action(
    guarded(async (idStr: string | undefined, opts: WriteFlags & { asiakas?: number; owner?: number; source: string; key: string }) => {
      writeJson(await runCustomerFkSet(await getClient(), resolveAsiakasTarget(idStr, opts.asiakas), opts, opts));
    })
  );

  addWriteFlagsToCommand(
    addOwnerOption(
      addAsiakasTargetOption(fk.command("add [asiakasId]")).requiredOption("--source <ref>").requiredOption("--key <text>")
    )
  ).action(
    guarded(async (idStr: string | undefined, opts: WriteFlags & { asiakas?: number; owner?: number; source: string; key: string }) => {
      writeJson(await runCustomerFkAdd(await getClient(), resolveAsiakasTarget(idStr, opts.asiakas), opts, opts));
    })
  );

  // <asiakasId> stays required and positional (no --asiakas alias): the
  // optional id after it would make an omitted customer id ambiguous.
  addWriteFlagsToCommand(
    addOwnerOption(fk.command("remove <asiakasId> [asiakasForeignKeyId]").option("--key <text>").option("--source <ref>"))
  ).action(
    guarded(async (idStr: string, fkId: string | undefined, opts: WriteFlags & { owner?: number; key?: string; source?: string }) => {
      writeJson(await runCustomerFkRemove(await getClient(), parseId(idStr, "asiakasId"), fkId, opts, opts));
    })
  );

  addWriteFlagsToCommand(addOwnerOption(fk.command("import <file>").option("--source <ref>"))).action(
    guarded(async (file: string, opts: WriteFlags & { source?: string; owner?: number }) => {
      let arr: unknown;
      try { arr = readJsonInput(file); } catch { failWith("import: file is not valid JSON", 4); }
      if (!Array.isArray(arr)) failWith("import: JSON root must be an array of { asiakasId, key, source? }", 4);
      writeJson(await runCustomerFkImport(await getClient(), arr, opts, opts));
    })
  );
}
