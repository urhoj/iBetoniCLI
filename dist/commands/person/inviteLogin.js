import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { assertEnum, intFlag, resolvePersonTarget } from "../../targets.js";
import { jsonAction } from "../_shared/action.js";
export const INVITE_CHANNELS = ["sms", "email"];
/**
 * POST /api/sms/invite-login (fb#2959): one login invite, SMS or email by the server's channel rule.
 * --dry-run is honoured server-side (X-Dry-Run): it picks the channel and builds the text, sends nothing.
 */
export async function runInviteLogin(client, personId, opts) {
    return client.post("/api/sms/invite-login", { personId, channel: opts.channel, orders: opts.orders !== false, message: opts.message, force: opts.force === true }, { headers: writeFlagsToHeaders(opts) });
}
/** Register `ib person invite-login [personId]`. Spec: src/reference/specs/person.ts. */
export function registerPersonInviteLoginCommand(parent, getClient) {
    addWriteFlagsToCommand(parent
        .command("invite-login [personId]")
        .description("Send one person a login invite (SMS, else email)")
        .option("--person <id>", "", intFlag("--person", 1))
        .option("--channel <channel>")
        .option("--no-orders")
        .option("--message <text>")
        .option("--force")).action(jsonAction(getClient, (client, idStr, opts) => {
        const personId = resolvePersonTarget(idStr, opts.person);
        assertEnum(opts.channel, INVITE_CHANNELS, "--channel");
        return runInviteLogin(client, personId, opts);
    }));
}
//# sourceMappingURL=inviteLogin.js.map