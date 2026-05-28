import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";
import { runKeikkaList } from "../keikka/index.js";

/**
 * Add `days` to an ISO `YYYY-MM-DD` date and return the same ISO format.
 * Used for the `week` command's `start..start+6` range.
 */
export function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `ib schedule today` — thin wrapper around runKeikkaList with from=to=today.
 */
export async function runScheduleToday(
  client: ApiClient
): Promise<ListEnvelope<Record<string, unknown>>> {
  const today = new Date().toISOString().slice(0, 10);
  return runKeikkaList(client, { from: today, to: today });
}

/**
 * `ib schedule day <date>` — runKeikkaList with from=to=date (ISO YYYY-MM-DD).
 */
export async function runScheduleDay(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Record<string, unknown>>> {
  return runKeikkaList(client, { from: date, to: date });
}

/**
 * `ib schedule week <start>` — runKeikkaList covering the 7-day window
 * [start, start+6]. `start` is an ISO YYYY-MM-DD date.
 */
export async function runScheduleWeek(
  client: ApiClient,
  start: string
): Promise<ListEnvelope<Record<string, unknown>>> {
  const end = addDaysISO(start, 6);
  return runKeikkaList(client, { from: start, to: end });
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
    .description("List today's keikkas (from=to=today)")
    .action(async () => {
      try {
        const client = await getClient();
        const result = await runScheduleToday(client);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  s.command("day <date>")
    .description("List keikkas for a single date (YYYY-MM-DD)")
    .action(async (date: string) => {
      try {
        const client = await getClient();
        const result = await runScheduleDay(client, date);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  s.command("week <start>")
    .description("List keikkas for the 7-day window starting <start> (YYYY-MM-DD)")
    .action(async (start: string) => {
      try {
        const client = await getClient();
        const result = await runScheduleWeek(client, start);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });
}
