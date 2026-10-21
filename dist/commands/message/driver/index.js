import { Option } from "commander";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../../api/writeFlags.js";
import { resolveActiveOwnerAsiakasId } from "../../../owner.js";
import { assertEnum, intFlag } from "../../../targets.js";
import { jsonAction } from "../../_shared/action.js";
import { applyFromJson } from "../../_shared/fromJson.js";
import { requireFlags } from "../../_shared/jsonBody.js";
import { listEnvelope } from "../../../api/envelopes.js";
import { addDaysISO, resolveDate, todayHelsinki } from "../../../dates.js";
import { failWith } from "../../../output/json.js";
const CHANNELS = ["push", "email"];
const DAY_CHANNELS = ["sms", "push", "email"];
/** `--date` → ISO day; default tomorrow (Helsinki), the day a dispatcher sends ahead for. */
export function dayMessageDate(date) {
    const iso = date === undefined ? addDaysISO(todayHelsinki(), 1) : resolveDate(date);
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso))
        return iso;
    return failWith(`--date must be YYYY-MM-DD or today/yesterday/tomorrow (got "${date}")`, 4);
}
export async function runDriverSend(client, opts) {
    return client.post("/api/sms/message", {
        personId: opts.person,
        channel: opts.channel,
        message: opts.message,
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    }, { headers: writeFlagsToHeaders(opts) });
}
export async function runDriverChannels(client, opts) {
    const owner = await resolveActiveOwnerAsiakasId(client);
    return client.get(`/api/sms/channels/${opts.person}/${owner}`);
}
/** GET /api/sms/day-text: the driver's day message as the dialog shows it, plus the preference and the channel to use. */
export async function runDriverDayText(client, opts) {
    const pvm = dayMessageDate(opts.date);
    const owner = await resolveActiveOwnerAsiakasId(client);
    return client.get(`/api/sms/day-text/${opts.person}/${owner}?pvm=${pvm}`);
}
/**
 * POST /api/sms/day-message (source "ib"). Without --channel it reads day-text first and sends on
 * the channel the server resolves for the driver (the dialog's preselect): a none_* preference does
 * not stop a manual send, exactly as in the dialog, but the output then carries day-text's `pref` and
 * `fallback` so the caller sees it (the dialog shows them as an Alert). The server rebuilds the text when
 * --message is omitted.
 */
export async function runDriverDaySend(client, opts) {
    const pvm = dayMessageDate(opts.date);
    let channel = opts.channel;
    let resolved = null;
    if (!channel) {
        const day = await runDriverDayText(client, { person: opts.person, date: pvm });
        if (!day?.channel)
            return failWith("no channel reaches this driver (no SMS number / push device / email): see ib message driver channels", 4);
        if (!day.text && opts.message === undefined)
            return failWith(`nothing to send: the driver has no orders on ${pvm} (pass --message to send your own text)`, 4);
        channel = day.channel;
        resolved = { pref: day.pref ?? null, fallback: !!day.fallback };
    }
    const result = await client.post("/api/sms/day-message", {
        personId: opts.person,
        pvm,
        channel,
        source: "ib",
        ...(opts.message !== undefined ? { message: opts.message } : {}),
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    }, { headers: writeFlagsToHeaders(opts) });
    return { channel, ...resolved, ...result };
}
/** GET /api/sms/day-messages: every day-message attempt of the active company for the day. */
export async function runDriverDayStatus(client, opts) {
    const pvm = dayMessageDate(opts.date);
    const owner = await resolveActiveOwnerAsiakasId(client);
    const raw = await client.get(`/api/sms/day-messages/${owner}?pvm=${pvm}`);
    return listEnvelope(raw?.items ?? []);
}
export function registerMessageDriverCommands(parent, getClient) {
    const driver = parent.command("driver").description("Manual push/email and the day message to a driver of the active company");
    driver.command("channels")
        .requiredOption("--person <id>", "", intFlag("--person", 1))
        .action(jsonAction(getClient, runDriverChannels));
    const send = driver.command("send")
        .option("--person <id>", "", intFlag("--person", 1))
        .addOption(new Option("--channel <channel>").choices(CHANNELS))
        .option("--message <text>")
        .option("--subject <text>")
        .option("--from-json <file|->");
    addWriteFlagsToCommand(send).action(jsonAction(getClient, (client, opts, cmd) => {
        const input = { ...opts };
        applyFromJson(cmd, input, {
            nonPayload: new Set(["fromJson", "dryRun", "idempotencyKey", "reason", "help"]),
            numericFields: new Set(["person"]),
        });
        requireFlags(cmd, input, ["person", "channel", "message"]);
        input.person = intFlag("--person", 1)(String(input.person));
        assertEnum(input.channel, CHANNELS, "--channel");
        return runDriverSend(client, input);
    }));
    driver.command("day-text")
        .requiredOption("--person <id>", "", intFlag("--person", 1))
        .option("--date <date>")
        .action(jsonAction(getClient, runDriverDayText));
    const daySend = driver.command("day-send")
        .requiredOption("--person <id>", "", intFlag("--person", 1))
        .option("--date <date>")
        .addOption(new Option("--channel <channel>").choices(DAY_CHANNELS))
        .option("--message <text>")
        .option("--subject <text>");
    addWriteFlagsToCommand(daySend).action(jsonAction(getClient, runDriverDaySend));
    driver.command("day-status")
        .option("--date <date>")
        .action(jsonAction(getClient, runDriverDayStatus));
}
//# sourceMappingURL=index.js.map