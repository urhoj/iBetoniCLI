import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { failWith, writeJson } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { assertEnum } from "../../targets.js";
import { guarded } from "../_shared/action.js";
import { applyFromJson, type FromJsonConfig } from "../_shared/fromJson.js";
import { requireFlags } from "../_shared/jsonBody.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { runPersonSearch } from "../person/index.js";

/**
 * Resolve a `--person`/positional value to a personId. A bare integer passes
 * through; anything else is treated as a name and resolved via the company-
 * scoped person search (`POST /api/person/search`). Exactly one match is
 * required — zero → exit 5, many → exit 4 listing the candidates so the caller
 * re-runs with the unambiguous personId. The search is already tenant-scoped,
 * so a name never resolves to someone outside the caller's company.
 */
export async function resolvePersonRef(
  client: ApiClient,
  ref: string
): Promise<number> {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const hits = (await runPersonSearch(client, trimmed)).items;
  if (hits.length === 0) {
    failWith(`No person matches "${ref}" in your company`, 5);
  }
  if (hits.length > 1) {
    const list = hits
      .slice(0, 10)
      .map((h) => `${h.personId} ${h.name}`)
      .join("; ");
    failWith(
      `"${ref}" is ambiguous (${hits.length} matches): ${list}. Re-run with the personId.`,
      4
    );
  }
  return hits[0].personId;
}

export interface NotifyFcmInput {
  /** personId (numeric) or a name to resolve within the caller's company. */
  person: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * POST /api/cli/notification/fcm/send — push an FCM notification to one person's
 * registered devices. Admin/HR-gated server-side (403 otherwise); the recipient
 * is tenant-scoped to the caller's company (404 cross-tenant). `--dry-run`
 * (X-Dry-Run) previews the recipient + active device count without sending.
 */
export async function runNotificationFcmSend(
  client: ApiClient,
  input: NotifyFcmInput,
  flags: WriteFlags
): Promise<unknown> {
  const personId = await resolvePersonRef(client, input.person);
  const body: Record<string, unknown> = {
    title: input.title,
    body: input.body,
    personId,
  };
  if (input.data !== undefined) body.data = input.data;
  return client.post("/api/cli/notification/fcm/send", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface NotifyEmailInput {
  /** personId (numeric), a name to resolve within the caller's company, or a raw email (contains "@"). */
  recipient: string;
  subject: string;
  text?: string;
  html?: string;
  fromBrand?: "betoni" | "betonijerry";
}

/**
 * POST /api/cli/notification/email/send — send an email to one person (resolved
 * within the caller's company) or a raw address. Admin/HR/developer-gated
 * server-side. A recipient containing "@" is sent as a raw address; otherwise it
 * is resolved to a personId. `--from-brand` picks the (whitelisted) sender.
 */
export async function runNotificationEmailSend(
  client: ApiClient,
  input: NotifyEmailInput,
  flags: WriteFlags
): Promise<unknown> {
  const body: Record<string, unknown> = {
    subject: input.subject,
    fromBrand: input.fromBrand ?? "betoni",
  };
  if (input.text !== undefined) body.text = input.text;
  if (input.html !== undefined) body.html = input.html;

  const r = input.recipient.trim();
  if (r.includes("@")) {
    body.email = r;
  } else {
    body.personId = await resolvePersonRef(client, r);
  }
  return client.post("/api/cli/notification/email/send", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Resolve the email HTML body from EITHER `--html <file>` (read from disk) OR
 * `--html-body <string>` (inline, for MCP/remote callers that can't reach the
 * caller's filesystem over the `ib_exec` bridge). Mutually exclusive; both →
 * exit 4. Returns undefined when neither is given.
 */
export function resolveEmailHtml(opts: { html?: string; htmlBody?: string }): string | undefined {
  if (opts.html && opts.htmlBody) {
    failWith("--html and --html-body are mutually exclusive", 4);
  }
  if (opts.htmlBody !== undefined) return opts.htmlBody;
  if (opts.html) {
    try {
      return readFileSync(opts.html, "utf8");
    } catch {
      failWith(`cannot read --html file: ${opts.html}`, 4);
    }
  }
  return undefined;
}

/**
 * Register `ib notification` — outbound notifications to people.
 * Subgroups: `notification fcm send` (FCM push), `notification email send` (email channel).
 * Admin/HR-gated server-side; `src/reference/specs.ts` is the source of truth for flags/permissions/output.
 */
export function registerNotificationCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const n = parent
    .command("notification")
    .description("Outbound notifications (push, email) to people");

  // --data is the only non-prose field here; --html is a PATH, so it round-trips
  // through a JSON string unharmed.
  const FCM_SEND_FROM_JSON: FromJsonConfig = {
    nonPayload: new Set(["fromJson", "dryRun", "reason", "idempotencyKey", "help"]),
    objectFields: new Set(["data"]),
  };
  const EMAIL_SEND_FROM_JSON: FromJsonConfig = {
    nonPayload: new Set(["fromJson", "dryRun", "reason", "idempotencyKey", "help"]),
  };
  const fcm = n
    .command("fcm")
    .description("Firebase Cloud Messaging push notifications");

  const sendCmd = fcm
    .command("send")
    .option(
      "--person <idOrName>"
    )
    .option("--title <text>")
    .option("--body <text>")
    .option(
      "--data <json>",
      "",
      (raw: string) => parseJsonBodyFlag(raw, "--data")
    )
    .option("--from-json <file>");
  addWriteFlagsToCommand(sendCmd).action(
    // `guarded`, not `jsonAction`: the --from-json merge and the required-flag
    // check must run BEFORE getClient(), so a malformed payload is exit 4 even
    // when logged out (same ordering rule as `ib message chat edit`).
    guarded(async (
      opts: WriteFlags & {
        person?: string;
        title?: string;
        body?: string;
        data?: Record<string, unknown>;
        fromJson?: string;
      },
      cmd: Command
    ) => {
      applyFromJson(cmd, opts as Record<string, unknown>, FCM_SEND_FROM_JSON);
      requireFlags(cmd, opts as Record<string, unknown>, ["person", "title", "body"]);
      writeJson(
        await runNotificationFcmSend(
          await getClient(),
          {
            person: opts.person as string,
            title: opts.title as string,
            body: opts.body as string,
            data: opts.data,
          },
          opts
        )
      );
    })
  );

  const email = n
    .command("email")
    .description("Email channel — send an email to a person or address");

  const emailSend = email
    .command("send <recipient>")
    .option("--subject <text>")
    .option("--body <text>")
    .option("--html <file>")
    .option(
      "--html-body <html>"
    )
    .option(
      "--from-brand <brand>",
      "",
      "betoni"
    )
    .option("--from-json <file>");
  addWriteFlagsToCommand(emailSend).action(
    guarded(async (
      recipient: string,
      opts: WriteFlags & {
        subject?: string;
        body?: string;
        html?: string;
        htmlBody?: string;
        fromBrand?: string;
        fromJson?: string;
      },
      cmd: Command
    ) => {
      applyFromJson(cmd, opts as Record<string, unknown>, EMAIL_SEND_FROM_JSON);
      requireFlags(cmd, opts as Record<string, unknown>, ["subject"]);
      if (!opts.body && !opts.html && !opts.htmlBody) {
        failWith("one of --body, --html, or --html-body is required", 4);
      }
      // Commander's default ("betoni", registered on the option) makes fromBrand
      // always defined here.
      assertEnum(opts.fromBrand, ["betoni", "betonijerry"], "--from-brand");
      const brand = opts.fromBrand as "betoni" | "betonijerry";
      const html = resolveEmailHtml({ html: opts.html, htmlBody: opts.htmlBody });
      const result = await runNotificationEmailSend(
        await getClient(),
        { recipient, subject: opts.subject as string, text: opts.body, html, fromBrand: brand },
        opts
      );
      writeJson(result);
    })
  );
}
