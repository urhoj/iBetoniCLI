import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
/**
 * GET /api/cli/driver/push-status — per member of the acting company: last login, active push
 * devices, the 20:00 push opt-in, the day-message channel and the push question's last outcome.
 */
export async function runPersonPushStatus(client, opts) {
    return client.get(`/api/cli/driver/push-status${qs({
        since: opts.since ? (resolveDate(opts.since) ?? opts.since) : undefined,
        driversOnly: opts.driversOnly ? "true" : undefined,
    })}`);
}
/** Register `ib person push-status`. See `src/reference/specs/person.ts` for the spec. */
export function registerPersonPushStatusCommand(parent, getClient) {
    parent
        .command("push-status")
        .option("--since <date>")
        .option("--drivers-only")
        .action(jsonAction(getClient, (client, opts) => runPersonPushStatus(client, opts)));
}
//# sourceMappingURL=pushStatus.js.map