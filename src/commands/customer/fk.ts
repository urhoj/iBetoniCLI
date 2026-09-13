/**
 * `ib customer fk` — customer foreign keys (dbo.asiakasForeignKeys), fb#1683.
 *
 * One key per (customer, source, owner): the backend POST is a real upsert
 * keyed that way, so `set` only needs the existing rows to name the action
 * (and to skip an exact-match no-op). The routes honour no X-Dry-Run, so
 * --dry-run resolves client-side; the DELETE is owner-scoped server-side and
 * the id is still checked against the customer's rows first, so a wrong id
 * exits 5 instead of a silent 0-row delete.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, unwrapRows, type ListEnvelope } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";
import { failWith, writeJson } from "../../output/json.js";
import { addAsiakasTargetOption, addOwnerOption, parseId, resolveAsiakasTarget } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { registerFkSourcesLeaf, resolveFkSource, resolveOwner } from "../_shared/foreignKeys.js";

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
): Promise<CustomerFkSetResult | { dryRun: true; would: CustomerFkSetResult }> {
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
  if (flags.dryRun) return { dryRun: true, would: result };
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

export interface CustomerFkRemoveResult {
  action: "removed";
  asiakasId: number;
  ownerAsiakasId: number;
  asiakasForeignKeyId: number;
  key: string;
  source: string;
  sourceId: number;
}

export async function runCustomerFkRemove(
  client: ApiClient,
  asiakasId: number,
  idStr: string,
  opts: { owner?: number },
  flags: WriteFlags
): Promise<CustomerFkRemoveResult | { dryRun: true; would: CustomerFkRemoveResult }> {
  const id = parseId(idStr, "asiakasForeignKeyId");
  const owner = resolveOwner(client, opts.owner);
  const row = (await fetchCustomerFks(client, asiakasId, owner)).find((r) => r.asiakasForeignKeyId === id);
  if (!row) {
    failWith(`asiakasForeignKeyId ${id} is not on customer ${asiakasId} for owner ${owner} — see \`ib customer fk list ${asiakasId} --owner ${owner}\``, 5);
  }
  const result: CustomerFkRemoveResult = {
    action: "removed",
    asiakasId,
    ownerAsiakasId: owner,
    asiakasForeignKeyId: id,
    key: row.key,
    source: row.source,
    sourceId: row.sourceId,
  };
  if (flags.dryRun) return { dryRun: true, would: result };
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

  // Two required positionals, no --asiakas alias: an optional positional ahead
  // of a required one is ambiguous to parse (which id did the caller omit?).
  addWriteFlagsToCommand(addOwnerOption(fk.command("remove <asiakasId> <asiakasForeignKeyId>"))).action(
    guarded(async (idStr: string, fkId: string, opts: WriteFlags & { owner?: number }) => {
      writeJson(await runCustomerFkRemove(await getClient(), parseId(idStr, "asiakasId"), fkId, opts, opts));
    })
  );
}
