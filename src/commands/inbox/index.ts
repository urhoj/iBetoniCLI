import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";

/**
 * The aggregated operator-inbox rollup returned by `GET /api/cli/inbox`.
 * Counts always present; the per-signal `items` are present only with `--details`.
 */
export interface InboxRollup {
  generatedAt: string | null;
  /** Headline: open feedback + legal drafts + open support + deploy-pending(bump!=none). */
  needsYou: number;
  changelog: {
    pending: number;
    deployPending: number;
    maxBumpLevel: string | null;
    items?: unknown[];
  };
  feedback: {
    open: number;
    reviewed: number;
    byKind: { open: Record<string, number>; reviewed: Record<string, number> };
    items?: { open: unknown[]; reviewed: unknown[] };
  };
  support: { open: number; truncated: boolean; items?: unknown[] };
  legal: { drafts: number; items?: unknown[] };
  glossary: { misses: number; items?: unknown[] };
  jerry: {
    noSupplyLive: number;
    noSupplyExpired: number;
    items?: unknown[];
  };
  memory:
    | {
        feedbackId: number;
        entryCount: number | null;
        flaggedForRetire: number | null;
        groomDate: string | null;
        daysSince: number | null;
      }
    | null;
}

/**
 * `ib inbox` — one aggregated rollup of the seven open/incomplete operator signals
 * (deploy-pending changelog, unresolved feedback, open support
 * escalations, staged legal drafts, glossary misses, live no_supply
 * tarjouspyynnot, and a memory-groom signal). The single source of truth
 * behind the daily morning-report routine and the /admin operator dashboard.
 * Read-only; developer-gated server-side.
 */
export async function runInbox(
  client: ApiClient,
  opts: { details?: boolean } = {}
): Promise<InboxRollup> {
  const qs = opts.details ? "?details=1" : "";
  return client.get<InboxRollup>(`/api/cli/inbox${qs}`);
}

export function registerInboxCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  parent
    .command("inbox", { hidden: !!opts.hidden })
    .description(
      "Aggregated operator inbox: counts of every open/incomplete signal (deploy-pending changelog, unresolved feedback, open support, staged legal drafts, glossary misses, live no_supply tarjouspyynnot) plus a memory-groom signal and a `needsYou` headline"
    )
    .option(
      "--details",
      "Include slimmed top-items per signal, not just counts"
    )
    .action(async (opts: { details?: boolean }) => {
      try {
        const client = await getClient();
        writeJson(await runInbox(client, { details: opts.details }));
      } catch (e) {
        exitWithError(e);
      }
    });
}
