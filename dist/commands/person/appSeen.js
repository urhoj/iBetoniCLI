import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
export async function runPersonAppSeen(client, opts) {
    return client.get(`/api/cli/driver/app-seen${qs({ date: resolveDate(opts.date) ?? opts.date })}`);
}
/** Register `ib person app-seen`. See `src/reference/specs/person.ts` for the spec. */
export function registerPersonAppSeenCommand(parent, getClient) {
    parent
        .command("app-seen")
        .requiredOption("--date <date>")
        .action(jsonAction(getClient, (client, opts) => runPersonAppSeen(client, opts)));
}
//# sourceMappingURL=appSeen.js.map