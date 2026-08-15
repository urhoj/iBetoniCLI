import { qs } from "../../../api/query.js";
import { jsonAction } from "../../_shared/action.js";
/**
 * Pass-through: the report shape is documented once, in the CommandSpec's
 * `outputShape`. A mirrored TS interface would buy nothing here (nothing reads
 * a field off it, and `client.get` does not validate) while silently rotting
 * every time the backend adds a column — this one had already drifted two
 * fields behind `senderHealth.js` within a day of being written.
 */
export async function runDevEmailHealth(client, opts = {}) {
    return client.get(`/api/email-health${qs({ days: opts.days })}`);
}
export function registerEmailHealthCommand(parent, getClient) {
    parent
        .command("email-health")
        .description("Account-wide SendGrid sender health — volume, deferral rate, recipient concentration")
        .option("--days <n>", "Window in days (1..90, default 7)", Number)
        .action(jsonAction(getClient, runDevEmailHealth));
}
//# sourceMappingURL=index.js.map