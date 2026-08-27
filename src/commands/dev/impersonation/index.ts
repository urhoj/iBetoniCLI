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
import { qs } from "../../../api/query.js";
import { writeJson } from "../../../output/json.js";
import { guarded, jsonAction } from "../../_shared/action.js";
import { parseId, intFlag, cappedInt } from "../../../targets.js";

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
    .option("--actor <id>", "", intFlag("--actor", 1))
    .option("--target <id>", "", intFlag("--target", 1))
    .option("--end-reason <r>")
    .option("--active")
    .option("--limit <n>", "", cappedInt(1000))
    .action(jsonAction(getClient, runImpersonationSessions));

  imp
    .command("grants <personId>")
    .action(guarded(async (personIdStr: string) => {
      const personId = parseId(personIdStr, "personId");
      writeJson(await runImpersonationGrants(await getClient(), personId));
    }));
}
