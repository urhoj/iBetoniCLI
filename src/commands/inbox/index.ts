import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";

/**
 * The aggregated operator-inbox rollup returned by `GET /api/cli/inbox`.
 * Counts always present; the per-signal `items` are present only with `--details`.
 */
export interface InboxRollup {
  generatedAt: string | null;
  /** Headline: open feedback + new bugs + legal drafts + open support + deploy-pending(bump!=none). */
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
  bugs: { new: number; items?: unknown[] };
  support: { open: number; truncated: boolean; items?: unknown[] };
  legal: { drafts: number; items?: unknown[] };
  glossary: { misses: number; items?: unknown[] };
}

/**
 * `ib inbox` — one aggregated rollup of the six open/incomplete operator signals
 * (deploy-pending changelog, unresolved feedback, new bugs, open support
 * escalations, staged legal drafts, glossary misses). The single source of truth
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
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("inbox")
    .description(
      "Aggregated operator inbox: counts of every open/incomplete signal (deploy-pending changelog, unresolved feedback, new bugs, open support, staged legal drafts, glossary misses) plus a `needsYou` headline"
    )
    .option(
      "--details",
      "Include slimmed top-items per signal (bugs stripped of sessionData), not just counts"
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
