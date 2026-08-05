import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
/**
 * GET /api/cli/driver/absences?from&to&personId — staff absences (personPvm 'pois'
 * rows: vacation / sick / etc.) in a date range. Staff-wide, person-keyed — this
 * is the canonical "who is away" query (an absent person cannot be set as a day
 * driver). Optional --person narrows to one person. Date aliases resolved first.
 */
export async function runPersonAbsences(client, opts) {
    return client.get(`/api/cli/driver/absences${qs({
        from: resolveDate(opts.from) ?? opts.from,
        to: resolveDate(opts.to) ?? opts.to,
        personId: opts.person,
    })}`);
}
/** Register `ib person absences`. See `src/reference/specs.ts` for the spec. */
export function registerPersonAbsencesCommand(parent, getClient) {
    parent
        .command("absences")
        .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
        .requiredOption("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)")
        .option("--person <pid>", "Filter to one personId", (s) => Number(s))
        .action(jsonAction(getClient, (client, opts) => runPersonAbsences(client, opts)));
}
//# sourceMappingURL=absences.js.map