import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
type Row = Record<string, unknown>;

export interface PersonAbsencesFilter {
  from: string;
  to: string;
  person?: number;
}

/**
 * GET /api/cli/driver/absences?from&to&personId — staff absences (personPvm 'pois'
 * rows: vacation / sick / etc.) in a date range. Staff-wide, person-keyed — this
 * is the canonical "who is away" query (an absent person cannot be set as a day
 * driver). Optional --person narrows to one person. Date aliases resolved first.
 */
export async function runPersonAbsences(
  client: ApiClient,
  opts: PersonAbsencesFilter
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(
    `/api/cli/driver/absences${qs({
      from: resolveDate(opts.from) ?? opts.from,
      to: resolveDate(opts.to) ?? opts.to,
      personId: opts.person,
    })}`
  );
}

/** Register `ib person absences`. See `src/reference/specs.ts` for the spec. */
export function registerPersonAbsencesCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("absences")
    .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .requiredOption("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .option("--person <pid>", "Filter to one personId", (s: string) => Number(s))
    .action(
      jsonAction(getClient, (client, opts: PersonAbsencesFilter) => runPersonAbsences(client, opts))
    );
}
