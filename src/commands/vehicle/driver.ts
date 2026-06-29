import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { parseId } from "../../targets.js";

type Row = Record<string, unknown>;

/** YYYY-MM-DD (or today/yesterday/tomorrow) → integer yyyymmdd. */
function toYyyymmdd(date: string): number {
  return Number(resolveDate(date)!.replace(/-/g, ""));
}

// ─── day-driver reads (date-keyed fleet views + per-vehicle) ─────────────────

/** GET /api/cli/driver/board/:yyyymmdd — every grid-eligible vehicle + driver/gap + keikka load for a day. */
export async function runVehicleDriverBoard(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/board/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/gaps/:yyyymmdd — vehicles needing a driver that day (the "Ei kuljettajaa" list). */
export async function runVehicleDriverGaps(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/gaps/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/available/:yyyymmdd — assignable drivers free + not absent that day. */
export async function runVehicleDriverAvailable(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/available/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/who/:vehicleId/:yyyymmdd — the day driver of one vehicle on a date. */
export async function runVehicleDriverWho(
  client: ApiClient,
  vehicleId: number,
  date: string
): Promise<Row> {
  return client.get<Row>(`/api/cli/driver/who/${vehicleId}/${toYyyymmdd(date)}`);
}

export interface VehicleDriverHistoryFilter {
  from: string;
  to: string;
}

/**
 * GET /api/cli/driver/history/:vehicleId?from&to — who was the DAY driver of this
 * vehicle on each day of a range. Sourced from `personPvm` (the live day-driver
 * table the grid reads), NOT the legacy `vehicleDriverDays`. One row per day that
 * had a driver. Date aliases resolved before the call.
 */
export async function runVehicleDriverHistory(
  client: ApiClient,
  vehicleId: number,
  opts: VehicleDriverHistoryFilter
): Promise<ListEnvelope<Row>> {
  const params = new URLSearchParams();
  params.set("from", resolveDate(opts.from) ?? opts.from);
  params.set("to", resolveDate(opts.to) ?? opts.to);
  return client.get<ListEnvelope<Row>>(
    `/api/cli/driver/history/${vehicleId}?${params.toString()}`
  );
}

// ─── day-driver writes (atomic cascade: personPvm + keikkaPerson + palkkiPerson) ──

/**
 * POST /api/cli/driver/assign — set the DAY driver of a vehicle for one date.
 * Atomic transaction (`performDriverReassign`, the SAME path the web grid uses):
 * writes `personPvm.vehicleId`, sets the driver on every keikka (`keikkaPerson`,
 * contactPersonTypeId=1) and palkki (`palkkiPerson`) on that vehicle that day, and
 * relocates the driver off any other vehicle they held that day. Returns the full
 * set of affected rows (keikkaIds/palkkiIds/oldPersonId/clearedFromVehicleId + names).
 */
export async function runVehicleDriverAssign(
  client: ApiClient,
  vehicleId: number,
  personId: number,
  date: string,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/cli/driver/assign",
    { vehicleId, personId, yyyymmdd: toYyyymmdd(date) },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /api/cli/driver/clear — remove the DAY driver from a vehicle for one date
 * (personId=null). Same atomic cascade as assign: clears the driver from that
 * day's keikkat/palkit and frees the person (personPvm.vehicleId=null) so they can
 * be reassigned. Returns the affected keikkaIds/palkkiIds + the displaced driver.
 */
export async function runVehicleDriverClear(
  client: ApiClient,
  vehicleId: number,
  date: string,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/cli/driver/clear",
    { vehicleId, yyyymmdd: toYyyymmdd(date) },
    { headers: writeFlagsToHeaders(flags) }
  );
}

// ─── default (standing) driver — the vehicle.defaultKuski_personId attribute ──

/**
 * Read a vehicle's STANDING default driver (`vehicle.defaultKuski_personId`),
 * distinct from the per-day driver. Reuses the vehicle record (GET
 * /api/cli/vehicle/get/:id) and projects the default-driver pointer.
 */
export async function runVehicleDefaultGet(
  client: ApiClient,
  vehicleId: number
): Promise<Row> {
  const row = await client.get<Row>(`/api/cli/vehicle/get/${vehicleId}`);
  return {
    vehicleId,
    defaultDriverPersonId: row?.defaultDriverId ?? null,
  };
}

/**
 * Set/clear the STANDING default driver via POST /api/vehicle/setDefaultPumppari
 * — the exact endpoint the FE "Oletus pumppari" control uses. `personId=null`
 * clears it. The backend cascades to FUTURE dates (re-points existing future
 * personPvm rows + future keikkaPerson) and returns a `cascade` summary of what
 * was touched. Pass-through of the controller response.
 */
export async function runVehicleDefaultSet(
  client: ApiClient,
  vehicleId: number,
  personId: number | null,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/vehicle/setDefaultPumppari",
    { vehicleId, personId },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/** Hard-require --reason at the CLI layer (exit 4), matching the other lifecycle writes. */
function requireReason(opts: WriteFlags): void {
  if (!opts.reason) failWith("Missing required flag: --reason", 4);
}

/**
 * Register the `ib vehicle driver` subgroup — the single home for ALL driver
 * operations keyed on a vehicle:
 *   board / gaps / available   fleet/day planning views (date-keyed)
 *   who / assign / clear / history   per-vehicle day-driver ops
 *   default get/set/clear       the vehicle's standing default driver
 *
 * `src/reference/specs.ts` is the source of truth for flags/permissions/output.
 * (Staff-wide "who's absent" lives at `ib person absences`.)
 */
export function registerVehicleDriverCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const driver = parent
    .command("driver")
    .description("Vehicle drivers: day-driver dispatch (board/gaps/available/who/assign/clear/history) + the standing default driver");

  // ── fleet / day planning reads (date-keyed) ──
  driver
    .command("board <date>")
    .description("All grid-eligible vehicles for a day with their driver / gap / keikka load")
    .action(async (date: string) => {
      try {
        writeJson(await runVehicleDriverBoard(await getClient(), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  driver
    .command("gaps <date>")
    .description("Vehicles needing a driver that day (the 'Ei kuljettajaa' list)")
    .action(async (date: string) => {
      try {
        writeJson(await runVehicleDriverGaps(await getClient(), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  driver
    .command("available <date>")
    .description("Drivers free to assign that day (pumpparit, minus already-assigned minus absent)")
    .action(async (date: string) => {
      try {
        writeJson(await runVehicleDriverAvailable(await getClient(), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  // ── per-vehicle day-driver ──
  driver
    .command("who <vehicleId> <date>")
    .description("The day driver assigned to a vehicle on a date (or null)")
    .action(async (vehicleIdStr: string, date: string) => {
      try {
        writeJson(await runVehicleDriverWho(await getClient(), parseId(vehicleIdStr, "vehicleId"), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  driver
    .command("history <vehicleId>")
    .description("Who drove this vehicle on each day of a range (from personPvm)")
    .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .requiredOption("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .action(async (vehicleIdStr: string, opts: VehicleDriverHistoryFilter) => {
      try {
        writeJson(
          await runVehicleDriverHistory(await getClient(), parseId(vehicleIdStr, "vehicleId"), opts)
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    driver
      .command("assign <vehicleId> <date>")
      .description("Set the day driver of a vehicle (atomic cascade: personPvm + keikkat + palkit). Requires --reason.")
      .requiredOption("--person <pid>", "Driver personId", (s: string) => Number(s))
  ).action(async (vehicleIdStr: string, date: string, opts: WriteFlags & { person: number }) => {
    requireReason(opts);
    try {
      writeJson(
        await runVehicleDriverAssign(await getClient(), parseId(vehicleIdStr, "vehicleId"), opts.person, date, opts)
      );
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    driver
      .command("clear <vehicleId> <date>")
      .description("Remove the day driver from a vehicle (atomic; frees the driver). Requires --reason.")
  ).action(async (vehicleIdStr: string, date: string, opts: WriteFlags) => {
    requireReason(opts);
    try {
      writeJson(
        await runVehicleDriverClear(await getClient(), parseId(vehicleIdStr, "vehicleId"), date, opts)
      );
    } catch (e) {
      exitWithError(e);
    }
  });

  // ── standing default driver ──
  const def = driver
    .command("default")
    .description("The vehicle's STANDING default driver (vehicle.defaultKuski_personId)");

  def
    .command("get <vehicleId>")
    .description("Read the vehicle's standing default driver personId")
    .action(async (vehicleIdStr: string) => {
      try {
        writeJson(await runVehicleDefaultGet(await getClient(), parseId(vehicleIdStr, "vehicleId")));
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    def
      .command("set <vehicleId>")
      .description("Set the standing default driver (cascades to future dates). Requires --reason.")
      .requiredOption("--person <pid>", "Default driver personId", (s: string) => Number(s))
  ).action(async (vehicleIdStr: string, opts: WriteFlags & { person: number }) => {
    requireReason(opts);
    try {
      writeJson(
        await runVehicleDefaultSet(await getClient(), parseId(vehicleIdStr, "vehicleId"), opts.person, opts)
      );
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    def
      .command("clear <vehicleId>")
      .description("Clear the standing default driver (cascades to future dates). Requires --reason.")
  ).action(async (vehicleIdStr: string, opts: WriteFlags) => {
    requireReason(opts);
    try {
      writeJson(
        await runVehicleDefaultSet(await getClient(), parseId(vehicleIdStr, "vehicleId"), null, opts)
      );
    } catch (e) {
      exitWithError(e);
    }
  });
}
