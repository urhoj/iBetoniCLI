import { writeJson, exitWithError } from "../../output/json.js";
import { runKeikkaList } from "../keikka/index.js";
import { todayHelsinki, resolveDate, addDaysISO } from "../../dates.js";
export { addDaysISO };
/**
 * `ib schedule today` — thin wrapper around runKeikkaList with from=to=today.
 */
export async function runScheduleToday(client) {
    const today = todayHelsinki();
    return runKeikkaList(client, { from: today, to: today });
}
/**
 * `ib schedule day <date>` — runKeikkaList with from=to=date (ISO YYYY-MM-DD).
 */
export async function runScheduleDay(client, date) {
    const d = resolveDate(date) ?? date;
    return runKeikkaList(client, { from: d, to: d });
}
/**
 * `ib schedule week <start>` — runKeikkaList covering the 7-day window
 * [start, start+6]. `start` is an ISO YYYY-MM-DD date.
 */
export async function runScheduleWeek(client, start) {
    const from = resolveDate(start) ?? start;
    const end = addDaysISO(from, 6);
    return runKeikkaList(client, { from, to: end });
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
export function registerScheduleCommands(parent, getClient) {
    const s = parent.command("schedule").description("Schedule (keikka window) commands");
    s.command("today")
        .description("List today's keikkas (from=to=today)")
        .action(async () => {
        try {
            const client = await getClient();
            const result = await runScheduleToday(client);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("day <date>")
        .description("List keikkas for a single date (YYYY-MM-DD)")
        .action(async (date) => {
        try {
            const client = await getClient();
            const result = await runScheduleDay(client, date);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("week <start>")
        .description("List keikkas for the 7-day window starting <start> (YYYY-MM-DD)")
        .action(async (start) => {
        try {
            const client = await getClient();
            const result = await runScheduleWeek(client, start);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map