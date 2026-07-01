import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { visibleSpecs, getCallerTier } from "../tier.js";
import { writeFlagsToHeaders } from "../api/writeFlags.js";
import { lineDiff } from "../textDiff.js";
import { applyTextEdit } from "../textEdit.js";
function resolveCommand(commandParts, tier) {
    // Be liberal in what we accept. Every discovery surface — including this
    // command's sibling `reference detail list` — emits `command` WITH the leading
    // `ib` (e.g. "ib vehicle driver available"). An AI naturally copies that value
    // straight back into `get`/`set`, which would otherwise double the prefix
    // ("ib ib vehicle driver available" → exit 5). Strip any leading `ib` token(s) and
    // collapse whitespace so the list→get round-trip just works, whether the path
    // arrives as separate args or one quoted string.
    const path = commandParts.join(" ").trim().replace(/\s+/g, " ").replace(/^(?:ib\s+)+/i, "");
    const command = `ib ${path}`.trim();
    const visible = visibleSpecs(COMMAND_SPECS, tier).some((s) => s.command === command);
    if (!visible) {
        throw new CliError(`unknown command: ${command}. Use \`ib commands\` for valid paths.`, 0, null, 5);
    }
    return command;
}
export async function runReferenceDetail(client, commandParts, tier = getCallerTier()) {
    const command = resolveCommand(commandParts, tier);
    return client.get(`/api/cli/command-catalog/${encodeURIComponent(command)}`);
}
export async function runReferenceDetailList(client, stalest, domain, withDetail = false, needsReview = false, maxConfidence) {
    const p = new URLSearchParams();
    if (stalest)
        p.set("stalest", String(stalest));
    if (domain)
        p.set("domain", domain);
    if (withDetail)
        p.set("withDetail", "1");
    if (needsReview)
        p.set("needsReview", "1");
    if (needsReview && maxConfidence != null)
        p.set("maxConfidence", String(maxConfidence));
    const q = p.toString();
    return client.get(`/api/cli/command-catalog${q ? `?${q}` : ""}`);
}
/**
 * Normalize a command path to the exact catalog key format (`ib <path>`) WITHOUT
 * the registry-visibility check `resolveCommand` enforces. `delete` targets
 * ORPHANED rows whose command no longer exists in the catalogue (a command
 * re-homed under a new domain leaves its old key behind), so it must accept an
 * arbitrary key. Strips any leading `ib` token(s) and collapses whitespace, so
 * `delete ib ai conversation`, `delete ai conversation`, and a single quoted
 * string all resolve to the same stored key. Empty path → exit 4.
 */
function normalizeCommandKey(commandParts) {
    const tokens = commandParts.join(" ").trim().split(/\s+/).filter(Boolean);
    while (tokens[0]?.toLowerCase() === "ib")
        tokens.shift();
    if (tokens.length === 0) {
        throw new CliError("a command path is required (e.g. `ib reference detail delete ai conversation`)", 0, null, 4);
    }
    return `ib ${tokens.join(" ")}`;
}
export async function runReferenceDetailDelete(client, commandParts, flags = {}) {
    // No resolveCommand() gate — the target is an orphan key, not a live command.
    const command = normalizeCommandKey(commandParts);
    return client.delete(`/api/cli/command-catalog/${encodeURIComponent(command)}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runReferenceDetailSet(client, commandParts, body, flags = {}, tier = getCallerTier()) {
    // Same client-side visibility gate as the read: an unknown (or tier-hidden)
    // command exits 5 before any write leaves the process.
    const command = resolveCommand(commandParts, tier);
    const payload = {};
    if (body.summary !== undefined)
        payload.summary = body.summary;
    if (body.detail !== undefined)
        payload.detail = body.detail;
    if (body.aiConfidence !== undefined)
        payload.aiConfidence = body.aiConfidence;
    if (body.needsHumanReview)
        payload.needsHumanReview = true;
    return client.put(`/api/cli/command-catalog/${encodeURIComponent(command)}`, payload, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** Catalog text fields editable in-field. */
export const DETAIL_EDITABLE_FIELDS = ["summary", "detail"];
/**
 * Edit mode for `reference detail set`: in-field partial edit of summary or
 * detail. Reads the current catalog entry (resolves + validates the command),
 * applies the edit, then `--dry-run` returns the field diff without writing, or
 * a real run delegates to `runReferenceDetailSet` (PATCH — only the edited field).
 */
export async function runReferenceDetailEdit(client, commandParts, field, op, flags = {}, tier = getCallerTier()) {
    const current = await runReferenceDetail(client, commandParts, tier);
    const before = String(current[field] ?? "");
    const { next, matchCount } = applyTextEdit(before, op);
    if (flags.dryRun) {
        const diff = lineDiff(before, next);
        return {
            dryRun: true,
            command: current.command,
            field,
            ...(matchCount !== undefined ? { matchCount } : {}),
            addedLines: diff.addedLines,
            removedLines: diff.removedLines,
            sameContent: diff.sameContent,
            unified: diff.unified,
        };
    }
    return runReferenceDetailSet(client, commandParts, { [field]: next }, flags, tier);
}
//# sourceMappingURL=detail.js.map