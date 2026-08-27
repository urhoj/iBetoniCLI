/**
 * `ib dev email-delivery` — what actually happened to ONE address's mail, or to
 * ONE message.
 *
 * Sibling of `ib dev email-health`, and the two answer different questions off
 * the same log: email-health is the ACCOUNT-WIDE watch (volume, deferral rate,
 * recipient concentration), this is the per-recipient one. Before it,
 * `dbo.log_SendGridWebhookEvents` was write-only — we recorded every outcome and
 * nothing could read one back, so "did the customer get it?" was answered by
 * opening the SendGrid dashboard by hand (fb#572).
 *
 * THE VERDICT IS THREE-VALUED ON PURPOSE. `no-data` is not `failing`: the log
 * only starts 2026-08-07, so an address with no rows has no evidence either way,
 * and every response carries `coverage` so the caller can tell those apart.
 * Collapsing them is the fb#506 mistake — a Jerry provider was called dark on
 * suppression-list membership while the event log showed the same message
 * delivered one second later.
 *
 * The HTTP path is /api/email-health/*, NOT /api/dev/* — that prefix is the
 * loopback-only devRouter that 404s on every deployed backend.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { qs } from "../../../api/query.js";
import { guarded } from "../../_shared/action.js";
import { writeJson, failUsage } from "../../../output/json.js";
import { cappedInt } from "../../../targets.js";

export async function runEmailDeliveryAddress(
  client: ApiClient,
  address: string,
  opts: { limit?: number } = {}
): Promise<Record<string, unknown>> {
  // encodeURIComponent, not a raw interpolation: an address is user data and
  // `#`/`?` in one would otherwise truncate the path or graft on a query string.
  return client.get(
    `/api/email-health/address/${encodeURIComponent(address)}${qs({ limit: opts.limit })}`
  );
}

export async function runEmailDeliveryMessage(
  client: ApiClient,
  sgMessageId: string
): Promise<Record<string, unknown>> {
  return client.get(`/api/email-health/message/${encodeURIComponent(sgMessageId)}`);
}

/**
 * Exactly one target. Positional and `--message` are two DIFFERENT lookups (an
 * address vs a SendGrid message id), not aliases for one — so this is a
 * mutually-exclusive pair validated inline, like `sijainti closest`, and NOT the
 * dual-target `resolveTarget` pattern, which exists for one target spelled two
 * ways.
 */
export function resolveDeliveryTarget(
  address: string | undefined,
  message: string | undefined
): { kind: "address"; value: string } | { kind: "message"; value: string } {
  if (address && message) {
    failUsage(
      "Pass EITHER an email address OR --message <sgMessageId>, not both — they are different lookups"
    );
  }
  if (address) return { kind: "address", value: address };
  if (message) return { kind: "message", value: message };
  return failUsage("Nothing to look up: pass an email address, or --message <sgMessageId>");
}

export function registerEmailDeliveryCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("email-delivery")
    .description("What the SendGrid event log knows about one address or one message")
    .argument("[address]", "Recipient email address to look up")
    .option("--message <sgMessageId>", "Look up one message's event history instead")
    .option("--limit <n>", "Max recent events for an address (1..200, default 50)", cappedInt(200))
    .action(
      guarded(async (address: string | undefined, opts: { message?: string; limit?: number }) => {
        const target = resolveDeliveryTarget(address, opts.message);
        const client = await getClient();
        writeJson(
          target.kind === "address"
            ? await runEmailDeliveryAddress(client, target.value, { limit: opts.limit })
            : await runEmailDeliveryMessage(client, target.value)
        );
      })
    );
}
