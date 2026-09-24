import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
type Row = Record<string, unknown>;

export interface PersonAppSeenFilter {
  date: string;
}

export async function runPersonAppSeen(
  client: ApiClient,
  opts: PersonAppSeenFilter
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(
    `/api/cli/driver/app-seen${qs({ date: resolveDate(opts.date) ?? opts.date })}`
  );
}

/** Register `ib person app-seen`. See `src/reference/specs/person.ts` for the spec. */
export function registerPersonAppSeenCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("app-seen")
    .requiredOption("--date <date>")
    .action(jsonAction(getClient, (client, opts: PersonAppSeenFilter) => runPersonAppSeen(client, opts)));
}
