import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";

export interface VehicleListFilter {
  limit?: number;
  cursor?: string;
}

/**
 * GET /api/cli/vehicle/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runVehicleList(
  client: ApiClient,
  opts: VehicleListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/vehicle/get/:vehicleId. Returns the flat backend record as-is.
 */
export async function runVehicleGet(
  client: ApiClient,
  vehicleId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/vehicle/get/${vehicleId}`
  );
}

/**
 * Register `ib vehicle` read subcommands on the parent commander instance:
 *   - list   filterable by --limit/--cursor
 *   - get    single vehicle by id
 *
 * v1.0 ships read-only; status/drivers commands are deferred per Phase 0.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerVehicleCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const v = parent.command("vehicle").description("Vehicle commands");

  v.command("list")
    .description("List vehicles")
    .option("--limit <n>", "Max rows", (val: string) => Math.min(Number(val), 500))
    .option("--cursor <c>", "Pagination cursor")
    .action(async (opts: VehicleListFilter) => {
      try {
        const client = await getClient();
        const result = await runVehicleList(client, opts);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  v.command("get <vehicleId>")
    .description("Get a single vehicle by vehicleId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runVehicleGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });
}
