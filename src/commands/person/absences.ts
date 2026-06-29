import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";

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
  const params = new URLSearchParams();
  params.set("from", resolveDate(opts.from) ?? opts.from);
  params.set("to", resolveDate(opts.to) ?? opts.to);
  if (opts.person !== undefined) params.set("personId", String(opts.person));
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/absences?${params.toString()}`);
}

/** Register `ib person absences`. See `src/reference/specs.ts` for the spec. */
export function registerPersonAbsencesCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("absences")
    .description("Staff absences (vacation/sick) in a date range — who is away / unassignable")
    .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .requiredOption("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .option("--person <pid>", "Filter to one personId", (s: string) => Number(s))
    .action(async (opts: PersonAbsencesFilter) => {
      try {
        writeJson(await runPersonAbsences(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });
}
