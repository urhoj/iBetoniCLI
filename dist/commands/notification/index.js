import { CliError, exitCodeFromStatus } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { runPersonSearch } from "../person/index.js";
/** Parse a `--data <json>` flag into a plain object (arrays/scalars rejected → exit 4). */
export function parseJsonObject(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new CliError("--data must be valid JSON", 400, null, exitCodeFromStatus(400));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError("--data must be a JSON object", 400, null, exitCodeFromStatus(400));
    }
    return parsed;
}
/**
 * Resolve a `--person`/positional value to a personId. A bare integer passes
 * through; anything else is treated as a name and resolved via the company-
 * scoped person search (`POST /api/person/search`). Exactly one match is
 * required — zero → exit 5, many → exit 4 listing the candidates so the caller
 * re-runs with the unambiguous personId. The search is already tenant-scoped,
 * so a name never resolves to someone outside the caller's company.
 */
export async function resolvePersonRef(client, ref) {
    const trimmed = ref.trim();
    if (/^\d+$/.test(trimmed))
        return Number(trimmed);
    const hits = (await runPersonSearch(client, trimmed)).items;
    if (hits.length === 0) {
        throw new CliError(`No person matches "${ref}" in your company`, 404, null, exitCodeFromStatus(404));
    }
    if (hits.length > 1) {
        const list = hits
            .slice(0, 10)
            .map((h) => `${h.personId} ${h.name}`)
            .join("; ");
        throw new CliError(`"${ref}" is ambiguous (${hits.length} matches): ${list}. Re-run with the personId.`, 400, null, exitCodeFromStatus(400));
    }
    return hits[0].personId;
}
/**
 * POST /api/cli/notification/fcm/send — push an FCM notification to one person's
 * registered devices. Admin/HR-gated server-side (403 otherwise); the recipient
 * is tenant-scoped to the caller's company (404 cross-tenant). `--dry-run`
 * (X-Dry-Run) previews the recipient + active device count without sending.
 */
export async function runNotificationFcmSend(client, input, flags) {
    const personId = await resolvePersonRef(client, input.person);
    const body = {
        title: input.title,
        body: input.body,
        personId,
    };
    if (input.data !== undefined)
        body.data = input.data;
    return client.post("/api/cli/notification/fcm/send", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Register `ib notification` — outbound notifications to people.
 * Phase 1: `notification fcm send` (FCM push). Email / in-app channels are
 * future subgroups (`notification email|inapp …`). Admin/HR-gated server-side;
 * `src/reference/specs.ts` is the source of truth for flags/permissions/output.
 */
export function registerNotificationCommands(parent, getClient) {
    const n = parent
        .command("notification")
        .description("Outbound notifications (push) to people");
    const fcm = n
        .command("fcm")
        .description("Firebase Cloud Messaging push notifications");
    const sendCmd = fcm
        .command("send")
        .description("Send an FCM push to one person's devices (Admin/HR only). --dry-run previews recipient + device count.")
        .requiredOption("--person <idOrName>", "Recipient personId, or a name resolved within your company")
        .requiredOption("--title <text>", "Notification title")
        .requiredOption("--body <text>", "Notification body")
        .option("--data <json>", "Extra FCM data payload as a JSON object", parseJsonObject);
    addWriteFlagsToCommand(sendCmd).action(async (opts) => {
        try {
            const result = await runNotificationFcmSend(await getClient(), {
                person: opts.person,
                title: opts.title,
                body: opts.body,
                data: opts.data,
            }, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map