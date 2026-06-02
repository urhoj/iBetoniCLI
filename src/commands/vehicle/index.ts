import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";

export interface VehicleListFilter {
  limit?: number;
  cursor?: string;
}

export interface VehicleDriversFilter {
  from?: string;
  to?: string;
}

export interface VehicleDayFilter {
  date?: string;
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
 * GET /api/cli/vehicle/status/:vehicleId. Returns the flat status record:
 * current driver, current keikka, and latest GPS ping (or null fields).
 */
export async function runVehicleStatus(
  client: ApiClient,
  vehicleId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/vehicle/status/${vehicleId}`
  );
}

/**
 * GET /api/cli/vehicle/drivers/:vehicleId — driver-assignment history over a
 * date range. Date aliases (today/yesterday/tomorrow) are resolved before the
 * call; query params are appended only when set.
 */
export async function runVehicleDrivers(
  client: ApiClient,
  vehicleId: number,
  opts: VehicleDriversFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/drivers/${vehicleId}${qs ? `?${qs}` : ""}`
  );
}

/** GET /api/cli/vehicle/locations — fleet-wide live position snapshot. */
export async function runVehicleLocations(
  client: ApiClient
): Promise<ListEnvelope<Record<string, unknown>> & { gpsAvailable: boolean }> {
  return client.get<ListEnvelope<Record<string, unknown>> & { gpsAvailable: boolean }>(
    "/api/cli/vehicle/locations"
  );
}

/** GET /api/cli/vehicle/timeline/:vehicleId?date= — per-day stop/travel segments. */
export async function runVehicleTimeline(
  client: ApiClient,
  vehicleId: number,
  opts: VehicleDayFilter
): Promise<ListEnvelope<Record<string, unknown>> & { gpsAvailable: boolean }> {
  const qs = opts.date ? `?date=${opts.date}` : "";
  return client.get<ListEnvelope<Record<string, unknown>> & { gpsAvailable: boolean }>(
    `/api/cli/vehicle/timeline/${vehicleId}${qs}`
  );
}

/**
 * Register `ib vehicle` subcommands on the parent commander instance:
 *   - list     filterable by --limit/--cursor
 *   - get      single vehicle by id
 *   - status   current driver + keikka + live GPS ping
 *   - drivers  driver-assignment history, filterable by --from/--to
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
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
        exitWithError(e);
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
        exitWithError(e);
      }
    });

  v.command("status <vehicleId>")
    .description("Current driver, keikka, and latest GPS ping for a vehicle")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runVehicleStatus(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("drivers <vehicleId>")
    .description("Driver-assignment history for a vehicle within a date range")
    .option("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .option("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .action(async (idStr: string, opts: VehicleDriversFilter) => {
      try {
        const client = await getClient();
        const result = await runVehicleDrivers(client, Number(idStr), {
          from: resolveDate(opts.from),
          to: resolveDate(opts.to),
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("locations")
    .description("Fleet-wide live GPS positions (current lat/lng + speed/heading/engine/address)")
    .action(async () => {
      try {
        const client = await getClient();
        writeJson(await runVehicleLocations(client));
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("timeline <vehicleId>")
    .description("Per-day GPS timeline: named stops (sijainti/tyomaa) + travel legs with durations")
    .option("--date <date>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .action(async (idStr: string, opts: VehicleDayFilter) => {
      try {
        const client = await getClient();
        writeJson(await runVehicleTimeline(client, Number(idStr), { date: resolveDate(opts.date) }));
      } catch (e) {
        exitWithError(e);
      }
    });
}
