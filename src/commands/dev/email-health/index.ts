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
import { jsonAction } from "../../_shared/action.js";

export interface EmailHealthFlag {
  code: string;
  severity: "critical" | "warning";
  detail: string;
}

export interface EmailHealthReport {
  days: number;
  checkedAt: string;
  coverage: { oldestEvent: string | null; newestEvent: string | null; daysWithData: number };
  totals: {
    processed: number;
    delivered: number;
    deferredEvents: number;
    deferredMessages: number;
    failed: number;
    spam: number;
  };
  daily: Record<string, unknown>[];
  recipients: { email: string; processed: number; sharePct: number }[];
  verdict: { healthy: boolean; flags: EmailHealthFlag[] };
}

export async function runDevEmailHealth(
  client: ApiClient,
  opts: { days?: number } = {}
): Promise<EmailHealthReport> {
  const qs = opts.days ? `?days=${encodeURIComponent(String(opts.days))}` : "";
  return client.get<EmailHealthReport>(`/api/email-health${qs}`);
}

export function registerEmailHealthCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("email-health")
    .description("Account-wide SendGrid sender health — volume, deferral rate, recipient concentration")
    .option("--days <n>", "Window in days (1..90, default 7)", Number)
    .action(
      jsonAction(getClient, (client, opts: { days?: number }) => runDevEmailHealth(client, opts))
    );
}
