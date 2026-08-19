import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { runKeikkaList } from "../keikka/index.js";
import { todayHelsinki, resolveDate, addDaysISO } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";

/** Schedule result shape: the keikka envelope plus which tenant it was scoped to. */
type ScheduleResult = ListEnvelope<Record<string, unknown>> & {
  scope: { asiakasId: number };
};

/**
 * Attach the queried tenant to a schedule result (fb#777): `schedule` answers
 * for the ACTIVE company only — unlike its sibling `ib stats`, which offers
 * `--all` for a cross-tenant rollup — and a bare 0-row result gave no signal
 * that other tenants were never searched. `asiakasId` comes straight off the
 * presented JWT (sync, no extra round-trip), so a 0 count reads as "none in
 * MY company" rather than a false "none scheduled anywhere".
 */
function withScope(client: ApiClient, envelope: ListEnvelope<Record<string, unknown>>): ScheduleResult {
  return { ...envelope, scope: { asiakasId: ownerAsiakasIdFromToken(client) } };
}

/**
 * `ib schedule today` — thin wrapper around runKeikkaList with from=to=today.
 */
export async function runScheduleToday(
  client: ApiClient
): Promise<ScheduleResult> {
  const today = todayHelsinki();
  return withScope(client, await runKeikkaList(client, { from: today, to: today }));
}

/**
 * `ib schedule day <date>` — runKeikkaList with from=to=date (ISO YYYY-MM-DD).
 */
export async function runScheduleDay(
  client: ApiClient,
  date: string
): Promise<ScheduleResult> {
  const d = resolveDate(date) ?? date;
  return withScope(client, await runKeikkaList(client, { from: d, to: d }));
}

/**
 * `ib schedule week <start>` — runKeikkaList covering the 7-day window
 * [start, start+6]. `start` is an ISO YYYY-MM-DD date.
 */
export async function runScheduleWeek(
  client: ApiClient,
  start: string
): Promise<ScheduleResult> {
  const from = resolveDate(start) ?? start;
  const end = addDaysISO(from, 6);
  return withScope(client, await runKeikkaList(client, { from, to: end }));
}

/**
 * Register `ib schedule` subcommands on the parent commander instance:
 *   - today          today's keikkas
 *   - day <date>     keikkas for a single ISO date
 *   - week <start>   keikkas for the 7-day window [start, start+6]
 *
 * All three are thin wrappers around `runKeikkaList` from D.2.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerScheduleCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const s = parent.command("schedule").description("Schedule (keikka window) commands");

  s.command("today")
    .action(jsonAction(getClient, runScheduleToday));

  s.command("day <date>")
    .action(jsonAction(getClient, (client, date: string) => runScheduleDay(client, date)));

  s.command("week <start>")
    .action(jsonAction(getClient, (client, start: string) => runScheduleWeek(client, start)));
}
