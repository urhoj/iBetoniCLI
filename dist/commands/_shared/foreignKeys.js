import { listEnvelope, unwrapRows } from "../../api/envelopes.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { failWith } from "../../output/json.js";
import { addOwnerOption } from "../../targets.js";
import { jsonAction } from "./action.js";
/** `--owner` when given, else the active company from the token (exit 4 when neither resolves). */
export function resolveOwner(client, owner) {
    return owner ?? ownerAsiakasIdFromToken(client);
}
export const dryRunOr = (flags, result) => flags.dryRun ? { dryRun: true, would: result } : result;
/** trim + lowercase — the same rule the Betomik driver matcher applies to a nickname. */
export const normKey = (s) => String(s ?? "").trim().toLowerCase();
export async function fetchFkSources(client, owner) {
    const rows = unwrapRows(await client.get(`/api/foreignKey/sourceList/${owner}`));
    return rows.map((r) => ({
        foreignKeySourceId: Number(r.foreignKeySourceId),
        name: String(r.foreignKeySourceName ?? ""),
        column: r.foreignKeySourceColumn == null ? null : String(r.foreignKeySourceColumn),
        ownerAsiakasId: r.ownerAsiakasId == null ? null : Number(r.ownerAsiakasId),
    }));
}
export async function runFkSources(client, owner) {
    return listEnvelope(await fetchFkSources(client, resolveOwner(client, owner)), { truncated: false });
}
/** Source name for an id, null when the id is not in the owner's list. */
export const sourceNameOf = (sources, id) => sources.find((s) => s.foreignKeySourceId === id)?.name ?? null;
/**
 * `--source` is a name (case-insensitive) or a numeric foreignKeySourceId.
 * Unknown → exit 4 naming what the owner CAN use, so the caller never has to
 * guess ids.
 */
export function pickFkSource(sources, ref, owner) {
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
export async function resolveFkSource(client, owner, ref) {
    return pickFkSource(await fetchFkSources(client, owner), ref, owner);
}
/** The `sources [--owner]` leaf every fk subgroup exposes. */
export function registerFkSourcesLeaf(group, getClient) {
    addOwnerOption(group.command("sources")).action(jsonAction(getClient, (client, opts) => runFkSources(client, opts.owner)));
}
//# sourceMappingURL=foreignKeys.js.map