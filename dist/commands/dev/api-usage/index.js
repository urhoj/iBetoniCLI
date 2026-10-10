import { qs } from "../../../api/query.js";
import { jsonAction } from "../../_shared/action.js";
/** Pass-through: the shape is documented once, in the CommandSpec's `outputShape`. */
export async function runDevApiUsage(client, opts = {}) {
    return client.get(`/api/cli/api-usage${qs({ service: opts.service })}`);
}
export function registerApiUsageCommand(parent, getClient) {
    parent
        .command("api-usage")
        .description("Live external-API budget counters (hour/day/month vs limits)")
        .option("--service <name>", "One API, e.g. ecofleet, fmi-weather, google-maps")
        .action(jsonAction(getClient, runDevApiUsage));
}
//# sourceMappingURL=index.js.map