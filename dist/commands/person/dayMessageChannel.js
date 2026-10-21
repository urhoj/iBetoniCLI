import { createRequire } from "node:module";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { diffFields } from "../../diff.js";
import { failWith } from "../../output/json.js";
import { assertEnum, intFlag, resolvePersonTarget } from "../../targets.js";
import { jsonAction } from "../_shared/action.js";
/** personSettings DAY_MESSAGE_CHANNEL (56, stringVar): how a driver wants the day message. */
export const DAY_MESSAGE_CHANNEL_TYPE_ID = createRequire(import.meta.url)("@ibetoni/constants").PERSON_SETTING_TYPE_IDS.DAY_MESSAGE_CHANNEL;
/** The six values the profile control saves; anything else (or blank) reads as "no preference" = SMS. */
export const DAY_MESSAGE_CHANNELS = ["sms", "whatsapp", "email", "push", "none_self", "none_manual"];
/** GET /api/person/setting/get/:personId/56 → { personId, value } (null = none saved, the driver gets SMS). */
export async function runDayMessageChannelGet(client, personId) {
    const rows = await client.get(`/api/person/setting/get/${personId}/${DAY_MESSAGE_CHANNEL_TYPE_ID}`);
    const raw = String(rows?.[0]?.stringVar ?? "").trim();
    return { personId, value: DAY_MESSAGE_CHANNELS.includes(raw) ? raw : null };
}
/**
 * POST /api/person/settings/set, the body the profile control posts. `value` null = clear (a blank
 * stringVar, read back as no preference). --dry-run resolves client-side: the route has no
 * X-Dry-Run guard, so it GETs the current value and reports the diff without POSTing.
 */
export async function runDayMessageChannelSet(client, personId, value, flags) {
    if (flags.dryRun) {
        const current = await runDayMessageChannelGet(client, personId);
        return { dryRun: true, personId, wouldChange: diffFields(current, { value }, ["value"]) };
    }
    return client.post("/api/person/settings/set", { personId, personSettingTypeId: DAY_MESSAGE_CHANNEL_TYPE_ID, boolVar: false, intVar: 0, stringVar: value ?? "" }, { headers: writeFlagsToHeaders(flags) });
}
/** Register `ib person day-message-channel get|set`. Specs: src/reference/specs/person.ts. */
export function registerPersonDayMessageChannelCommands(parent, getClient) {
    const group = parent
        .command("day-message-channel")
        .description("Read/set how a driver wants the day message (personSettings 56)");
    group
        .command("get [personId]")
        .option("--person <id>", "", intFlag("--person", 1))
        .action(jsonAction(getClient, (client, idStr, opts) => runDayMessageChannelGet(client, resolvePersonTarget(idStr, opts.person))));
    addWriteFlagsToCommand(group
        .command("set [personId]")
        .option("--person <id>", "", intFlag("--person", 1))
        .option("--value <value>")
        .option("--clear")).action(jsonAction(getClient, (client, idStr, opts) => {
        const personId = resolvePersonTarget(idStr, opts.person);
        if ((opts.value === undefined) === !opts.clear)
            failWith("pass exactly one of --value <channel> or --clear", 4);
        assertEnum(opts.value, DAY_MESSAGE_CHANNELS, "--value");
        return runDayMessageChannelSet(client, personId, opts.clear ? null : opts.value, opts);
    }));
}
//# sourceMappingURL=dayMessageChannel.js.map