import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
type Row = Record<string, unknown>;

export interface PersonPushStatusFilter {
  since?: string;
  driversOnly?: boolean;
}

/**
 * GET /api/cli/driver/push-status — per member of the acting company: last login, active push
 * devices, the 20:00 push opt-in, the day-message channel and the push question's last outcome.
 */
export async function runPersonPushStatus(client: ApiClient, opts: PersonPushStatusFilter): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(
    `/api/cli/driver/push-status${qs({
      since: opts.since ? (resolveDate(opts.since) ?? opts.since) : undefined,
      driversOnly: opts.driversOnly ? "true" : undefined,
    })}`
  );
}

/** Register `ib person push-status`. See `src/reference/specs/person.ts` for the spec. */
export function registerPersonPushStatusCommand(parent: Command, getClient: () => Promise<ApiClient>): void {
  parent
    .command("push-status")
    .option("--since <date>")
    .option("--drivers-only")
    .action(jsonAction(getClient, (client, opts: PersonPushStatusFilter) => runPersonPushStatus(client, opts)));
}
