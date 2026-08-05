import { runKeikkaList } from "../keikka/index.js";
import { todayHelsinki, resolveDate, addDaysISO } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
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
        .action(jsonAction(getClient, runScheduleToday));
    s.command("day <date>")
        .action(jsonAction(getClient, (client, date) => runScheduleDay(client, date)));
    s.command("week <start>")
        .action(jsonAction(getClient, (client, start) => runScheduleWeek(client, start)));
}
//# sourceMappingURL=index.js.map