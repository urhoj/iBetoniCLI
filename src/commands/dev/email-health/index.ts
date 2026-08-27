/**
 * `ib dev email-health` — account-wide deliverability watch for our SendGrid
 * sender (`noreply@ibetoni.fi`).
 *
 * Exists because Gmail throttled us for a whole afternoon (`421 4.7.28`) and
 * nothing noticed: deferrals are transient, so the deploy health check
 * deliberately ignores them, which leaves the RATE unwatched — and the rate is
 * the warning that precedes real blocking (fb#575).
 *
 * Distinct from `ib jerry email-activity`, which asks SendGrid's API about the
 * `betonijerry.fi` domain and needs the read-only diagnostic key. This one
 * reads our own webhook event log, needs no key, and answers the question that
 * actually found the incident: WHO the volume went to. The fb#575 signature was
 * 86% of the account's mail going to one internal address — invisible in any
 * domain-level or aggregate view.
 *
 * The HTTP path is /api/email-health, NOT /api/dev/* — that prefix is the
 * loopback-only devRouter that 404s on every deployed backend.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { qs } from "../../../api/query.js";
import { jsonAction } from "../../_shared/action.js";
import { intFlag } from "../../../targets.js";

/**
 * Pass-through: the report shape is documented once, in the CommandSpec's
 * `outputShape`. A mirrored TS interface would buy nothing here (nothing reads
 * a field off it, and `client.get` does not validate) while silently rotting
 * every time the backend adds a column — this one had already drifted two
 * fields behind `senderHealth.js` within a day of being written.
 */
export async function runDevEmailHealth(
  client: ApiClient,
  opts: { days?: number } = {}
): Promise<Record<string, unknown>> {
  return client.get(`/api/email-health${qs({ days: opts.days })}`);
}

export function registerEmailHealthCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("email-health")
    .description("Account-wide SendGrid sender health — volume, deferral rate, recipient concentration")
    .option("--days <n>", "Window in days (1..90, default 7)", intFlag("--days", 1))
    .action(jsonAction(getClient, runDevEmailHealth));
}
