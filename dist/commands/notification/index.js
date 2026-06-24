import { readFileSync } from "node:fs";
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
 * POST /api/cli/notification/email/send — send an email to one person (resolved
 * within the caller's company) or a raw address. Admin/HR/developer-gated
 * server-side. A recipient containing "@" is sent as a raw address; otherwise it
 * is resolved to a personId. `--from-brand` picks the (whitelisted) sender.
 */
export async function runNotificationEmailSend(client, input, flags) {
    const body = {
        subject: input.subject,
        fromBrand: input.fromBrand ?? "betoni",
    };
    if (input.text !== undefined)
        body.text = input.text;
    if (input.html !== undefined)
        body.html = input.html;
    const r = input.recipient.trim();
    if (r.includes("@")) {
        body.email = r;
    }
    else {
        body.personId = await resolvePersonRef(client, r);
    }
    return client.post("/api/cli/notification/email/send", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Register `ib notification` — outbound notifications to people.
 * Subgroups: `notification fcm send` (FCM push), `notification email send` (email channel).
 * Admin/HR-gated server-side; `src/reference/specs.ts` is the source of truth for flags/permissions/output.
 */
export function registerNotificationCommands(parent, getClient) {
    const n = parent
        .command("notification")
        .description("Outbound notifications (push, email) to people");
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
    const email = n
        .command("email")
        .description("Email channel — send an email to a person or address");
    const emailSend = email
        .command("send <recipient>")
        .description("Send an email to a personId/name (resolved in your company) or a raw address (Admin/HR/developer only). One of --body/--html required. --dry-run previews the resolved recipient + sender.")
        .requiredOption("--subject <text>", "Email subject")
        .option("--body <text>", "Plain-text body (auto-wrapped to HTML)")
        .option("--html <file>", "Path to an HTML file to send as the HTML body")
        .option("--from-brand <brand>", "Sender identity: betoni (default, noreply@ibetoni.fi) or betonijerry (noreply@betonijerry.fi)", "betoni");
    addWriteFlagsToCommand(emailSend).action(async (recipient, opts) => {
        try {
            if (!opts.body && !opts.html) {
                throw new CliError("one of --body or --html is required", 400, null, exitCodeFromStatus(400));
            }
            const brand = opts.fromBrand ?? "betoni";
            if (brand !== "betoni" && brand !== "betonijerry") {
                throw new CliError("--from-brand must be 'betoni' or 'betonijerry'", 400, null, exitCodeFromStatus(400));
            }
            let html;
            if (opts.html) {
                try {
                    html = readFileSync(opts.html, "utf8");
                }
                catch {
                    throw new CliError(`cannot read --html file: ${opts.html}`, 400, null, exitCodeFromStatus(400));
                }
            }
            const result = await runNotificationEmailSend(await getClient(), { recipient, subject: opts.subject, text: opts.body, html, fromBrand: brand }, {
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