/**
 * `ib dev api-usage` — live external-API budget counters (fb#1380).
 *
 * Reads the Redis counters apiTracking enforces (`api:track:global:<api>:
 * {hour,day,month}:<period>`), not the `api_usage_log` mirror: the log
 * double-counts against them and cannot say whether the NEXT call will be
 * refused. Answers "how much headroom does Ecofleet have?" before an agent adds
 * a poller.
 *
 * The HTTP path is /api/cli/api-usage, NOT /api/dev/* — that prefix is the
 * loopback-only devRouter that 404s on every deployed backend.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { qs } from "../../../api/query.js";
import { jsonAction } from "../../_shared/action.js";

/** Pass-through: the shape is documented once, in the CommandSpec's `outputShape`. */
export async function runDevApiUsage(
  client: ApiClient,
  opts: { service?: string } = {}
): Promise<Record<string, unknown>> {
  return client.get(`/api/cli/api-usage${qs({ service: opts.service })}`);
}

export function registerApiUsageCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("api-usage")
    .description("Live external-API budget counters (hour/day/month vs limits)")
    .option("--service <name>", "One API, e.g. ecofleet, fmi-weather, google-maps")
    .action(jsonAction(getClient, runDevApiUsage));
}
