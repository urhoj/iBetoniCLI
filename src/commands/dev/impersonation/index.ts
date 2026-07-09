/**
 * `ib dev impersonation` — developer-gated, read-only impersonation audit trail.
 *
 * - `sessions` reconstructs impersonation sessions from personLog 30/31/32
 *   (start/end/extend) joined on sessionId, over GET /api/cli/impersonation-sessions.
 *   Answers "did endReason=logout rows land in prod?" without hand-written SQL.
 * - `grants <personId>` surfaces the existing GET /api/persons/:id/impersonation-grants
 *   (who may impersonate whom). Both are reads (safe under --read-only).
 *
 * Deploy-gated: `sessions` no-ops until the puminet5api backend route ships.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import type { ListEnvelope } from "../../../api/envelopes.js";
import { writeJson, exitWithError } from "../../../output/json.js";
import { parseId } from "../../../targets.js";

export interface ImpersonationSession {
  sessionId: string;
  actorPersonId: number | null;
  targetPersonId: number | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  startTime: string | null;
  extendCount: number;
  lastExtendTime: string | null;
  endTime: string | null;
  endReason: string | null;
  durationSeconds: number | null;
  active: boolean;
}

export interface ImpersonationSessionsOpts {
  actor?: number;
  target?: number;
  endReason?: string;
  active?: boolean;
  limit?: number;
}

/** Build a `?k=v&...` suffix from the defined filters. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

/**
 * GET /api/cli/impersonation-sessions — reconstructed sessions as a ListEnvelope.
 * The backend returns `{ items, count, truncated }`.
 */
export async function runImpersonationSessions(
  client: ApiClient,
  opts: ImpersonationSessionsOpts
): Promise<ListEnvelope<ImpersonationSession>> {
  const res = await client.get<{ items: ImpersonationSession[]; count: number; truncated: boolean }>(
    `/api/cli/impersonation-sessions${qs({
      actor: opts.actor,
      target: opts.target,
      endReason: opts.endReason,
      active: opts.active,
      limit: opts.limit,
    })}`
  );
  return {
    items: res.items ?? [],
    nextCursor: null,
    count: res.count ?? (res.items ?? []).length,
    truncated: res.truncated ?? false,
  };
}

/** GET /api/persons/:personId/impersonation-grants — { outbound, inbound }. */
export async function runImpersonationGrants(
  client: ApiClient,
  personId: number
): Promise<unknown> {
  return client.get(`/api/persons/${personId}/impersonation-grants`);
}

/** Register `ib dev impersonation`. See `src/reference/specs.ts` for the specs. */
export function registerImpersonationCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const imp = parent
    .command("impersonation")
    .description("Impersonation audit trail — reconstructed sessions + grants (developer-only)");

  imp
    .command("sessions")
    .description("Reconstructed impersonation sessions (personLog 30/31/32) with endReason")
    .option("--actor <id>", "Filter to sessions run BY this actor personId", (s: string) => Number(s))
    .option("--target <id>", "Filter to sessions run AS this target personId", (s: string) => Number(s))
    .option("--end-reason <r>", "Filter by endReason (manual|timeout|error|logout)")
    .option("--active", "Only still-open sessions (no end row)")
    .option("--limit <n>", "Max sessions (default 100, max 1000)", (s: string) => Number(s))
    .action(async (opts: ImpersonationSessionsOpts) => {
      try {
        writeJson(await runImpersonationSessions(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  imp
    .command("grants <personId>")
    .description("Who may impersonate whom for one person (outbound/inbound grants)")
    .action(async (personIdStr: string) => {
      try {
        const personId = parseId(personIdStr, "personId");
        writeJson(await runImpersonationGrants(await getClient(), personId));
      } catch (e) {
        exitWithError(e);
      }
    });
}
