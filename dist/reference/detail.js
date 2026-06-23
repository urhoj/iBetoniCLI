import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { visibleSpecs, getCallerTier } from "../tier.js";
import { writeFlagsToHeaders } from "../api/writeFlags.js";
function resolveCommand(commandParts, tier) {
    // Be liberal in what we accept. Every discovery surface — including this
    // command's sibling `reference detail list` — emits `command` WITH the leading
    // `ib` (e.g. "ib driver available"). An AI naturally copies that value straight
    // back into `get`/`set`, which would otherwise double the prefix
    // ("ib ib driver available" → exit 5). Strip any leading `ib` token(s) and
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
//# sourceMappingURL=detail.js.map