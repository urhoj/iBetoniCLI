import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { visibleSpecs, getCallerTier } from "../tier.js";
import { writeFlagsToHeaders } from "../api/writeFlags.js";
function resolveCommand(commandParts, tier) {
    const command = `ib ${commandParts.join(" ")}`.trim();
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
export async function runReferenceDetailList(client, stalest, domain) {
    const p = new URLSearchParams();
    if (stalest)
        p.set("stalest", String(stalest));
    if (domain)
        p.set("domain", domain);
    const q = p.toString();
    return client.get(`/api/cli/command-catalog${q ? `?${q}` : ""}`);
}
export async function runReferenceDetailSet(client, commandParts, body, flags = {}, tier = getCallerTier()) {
    // Same client-side visibility gate as the read: an unknown (or tier-hidden)
    // command exits 5 before any write leaves the process.
    const command = resolveCommand(commandParts, tier);
    return client.put(`/api/cli/command-catalog/${encodeURIComponent(command)}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
//# sourceMappingURL=detail.js.map