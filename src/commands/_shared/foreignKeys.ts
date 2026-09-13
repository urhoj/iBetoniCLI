/**
 * Shared half of the three `ib <entity> fk` subgroups (person / customer /
 * vehicle, fb#1683): the tenant-scoped source list, `--source <name|id>`
 * resolution, and the owner default. Every foreign key hangs off a row of
 * `dbo.foreignKeySources` (`GET /api/foreignKey/sourceList/:ownerAsiakasId`
 * returns the owner's rows plus the global ones), so the three groups resolve
 * `--source` identically and expose the same `sources` leaf.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, unwrapRows, type ListEnvelope } from "../../api/envelopes.js";
import type { WriteFlags } from "../../api/writeFlags.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { failWith } from "../../output/json.js";
import { addOwnerOption } from "../../targets.js";
import { jsonAction } from "./action.js";

export interface FkSource {
  foreignKeySourceId: number;
  name: string;
  column: string | null;
  ownerAsiakasId: number | null;
}

/** `--owner` when given, else the active company from the token (exit 4 when neither resolves). */
export function resolveOwner(client: ApiClient, owner?: number): number {
  return owner ?? ownerAsiakasIdFromToken(client);
}

/** Client-side dry-run envelope shared by the person/customer writes: the plan, never sent. */
export type MaybeDryRun<T> = T | { dryRun: true; would: T };
export const dryRunOr = <T>(flags: WriteFlags, result: T): MaybeDryRun<T> =>
  flags.dryRun ? { dryRun: true, would: result } : result;

/** trim + lowercase — the same rule the Betomik driver matcher applies to a nickname. */
export const normKey = (s: unknown): string => String(s ?? "").trim().toLowerCase();

export async function fetchFkSources(client: ApiClient, owner: number): Promise<FkSource[]> {
  const rows = unwrapRows(await client.get(`/api/foreignKey/sourceList/${owner}`));
  return rows.map((r) => ({
    foreignKeySourceId: Number(r.foreignKeySourceId),
    name: String(r.foreignKeySourceName ?? ""),
    column: r.foreignKeySourceColumn == null ? null : String(r.foreignKeySourceColumn),
    ownerAsiakasId: r.ownerAsiakasId == null ? null : Number(r.ownerAsiakasId),
  }));
}

export async function runFkSources(client: ApiClient, owner?: number): Promise<ListEnvelope<FkSource>> {
  return listEnvelope(await fetchFkSources(client, resolveOwner(client, owner)), { truncated: false });
}

/** Source name for an id, null when the id is not in the owner's list. */
export const sourceNameOf = (sources: FkSource[], id: number): string | null =>
  sources.find((s) => s.foreignKeySourceId === id)?.name ?? null;

/**
 * `--source` is a name (case-insensitive) or a numeric foreignKeySourceId.
 * Unknown → exit 4 naming what the owner CAN use, so the caller never has to
 * guess ids.
 */
export function pickFkSource(sources: FkSource[], ref: string, owner: number): FkSource {
  const trimmed = ref.trim();
  const hit = /^\d+$/.test(trimmed)
    ? sources.find((s) => s.foreignKeySourceId === Number(trimmed))
    : sources.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  if (!hit) {
    const names = sources.map((s) => `${s.name} (${s.foreignKeySourceId})`).join(", ") || "none";
    failWith(`unknown foreign-key source "${ref}" for owner ${owner} — available: ${names}`, 4);
  }
  return hit;
}

export async function resolveFkSource(client: ApiClient, owner: number, ref: string): Promise<FkSource> {
  return pickFkSource(await fetchFkSources(client, owner), ref, owner);
}

/** The `sources [--owner]` leaf every fk subgroup exposes. */
export function registerFkSourcesLeaf(group: Command, getClient: () => Promise<ApiClient>): void {
  addOwnerOption(group.command("sources")).action(
    jsonAction(getClient, (client, opts: { owner?: number }) => runFkSources(client, opts.owner))
  );
}
