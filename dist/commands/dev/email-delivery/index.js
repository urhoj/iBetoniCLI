import { qs } from "../../../api/query.js";
import { guarded } from "../../_shared/action.js";
import { writeJson, failUsage } from "../../../output/json.js";
export async function runEmailDeliveryAddress(client, address, opts = {}) {
    // encodeURIComponent, not a raw interpolation: an address is user data and
    // `#`/`?` in one would otherwise truncate the path or graft on a query string.
    return client.get(`/api/email-health/address/${encodeURIComponent(address)}${qs({ limit: opts.limit })}`);
}
export async function runEmailDeliveryMessage(client, sgMessageId) {
    return client.get(`/api/email-health/message/${encodeURIComponent(sgMessageId)}`);
}
/**
 * Exactly one target. Positional and `--message` are two DIFFERENT lookups (an
 * address vs a SendGrid message id), not aliases for one — so this is a
 * mutually-exclusive pair validated inline, like `sijainti closest`, and NOT the
 * dual-target `resolveTarget` pattern, which exists for one target spelled two
 * ways.
 */
export function resolveDeliveryTarget(address, message) {
    if (address && message) {
        failUsage("Pass EITHER an email address OR --message <sgMessageId>, not both — they are different lookups");
    }
    if (address)
        return { kind: "address", value: address };
    if (message)
        return { kind: "message", value: message };
    return failUsage("Nothing to look up: pass an email address, or --message <sgMessageId>");
}
export function registerEmailDeliveryCommand(parent, getClient) {
    parent
        .command("email-delivery")
        .description("What the SendGrid event log knows about one address or one message")
        .argument("[address]", "Recipient email address to look up")
        .option("--message <sgMessageId>", "Look up one message's event history instead")
        .option("--limit <n>", "Max recent events for an address (1..200, default 50)", Number)
        .action(guarded(async (address, opts) => {
        const target = resolveDeliveryTarget(address, opts.message);
        const client = await getClient();
        writeJson(target.kind === "address"
            ? await runEmailDeliveryAddress(client, target.value, { limit: opts.limit })
            : await runEmailDeliveryMessage(client, target.value));
    }));
}
//# sourceMappingURL=index.js.map