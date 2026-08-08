import { writeJson } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { parseId } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
import { markPlaceholderVehicles } from "./placeholder.js";
/** YYYY-MM-DD (or today/yesterday/tomorrow) → integer yyyymmdd. */
function toYyyymmdd(date) {
    return Number(resolveDate(date).replace(/-/g, ""));
}
// ─── day-driver reads (date-keyed fleet views + per-vehicle) ─────────────────
/**
 * GET /api/cli/driver/board/:yyyymmdd — every grid-eligible vehicle + driver/gap
 * + keikka load for a day. Sentinel rows are stamped `placeholder: true` so a
 * non-assignable legacy row isn't read as a driverless truck (fb#380).
 */
export async function runVehicleDriverBoard(client, date) {
    return markPlaceholderVehicles(await client.get(`/api/cli/driver/board/${toYyyymmdd(date)}`));
}
/**
 * GET /api/cli/driver/gaps/:yyyymmdd — vehicles needing a driver that day (the
 * "Ei kuljettajaa" list). Server-side these are the board rows filtered to
 * `needsDriver`, so they get the same placeholder stamp — a sentinel marked on
 * the board but bare here would be a contract the caller could trip on.
 */
export async function runVehicleDriverGaps(client, date) {
    return markPlaceholderVehicles(await client.get(`/api/cli/driver/gaps/${toYyyymmdd(date)}`));
}
/** GET /api/cli/driver/available/:yyyymmdd — assignable drivers free + not absent that day. */
export async function runVehicleDriverAvailable(client, date) {
    return client.get(`/api/cli/driver/available/${toYyyymmdd(date)}`);
}
/** GET /api/cli/driver/who/:vehicleId/:yyyymmdd — the day driver of one vehicle on a date. */
export async function runVehicleDriverWho(client, vehicleId, date) {
    return client.get(`/api/cli/driver/who/${vehicleId}/${toYyyymmdd(date)}`);
}
/**
 * GET /api/cli/driver/history/:vehicleId?from&to — who was the DAY driver of this
 * vehicle on each day of a range. Sourced from `personPvm` (the live day-driver
 * table the grid reads), NOT the legacy `vehicleDriverDays`. One row per day that
 * had a driver. Date aliases resolved before the call.
 */
export async function runVehicleDriverHistory(client, vehicleId, opts) {
    return client.get(`/api/cli/driver/history/${vehicleId}${qs({
        from: resolveDate(opts.from) ?? opts.from,
        to: resolveDate(opts.to) ?? opts.to,
    })}`);
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
export async function runVehicleDriverAssign(client, vehicleId, personId, date, flags) {
    return client.post("/api/cli/driver/assign", { vehicleId, personId, yyyymmdd: toYyyymmdd(date) }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/cli/driver/clear — remove the DAY driver from a vehicle for one date
 * (personId=null). Same atomic cascade as assign: clears the driver from that
 * day's keikkat/palkit and frees the person (personPvm.vehicleId=null) so they can
 * be reassigned. Returns the affected keikkaIds/palkkiIds + the displaced driver.
 */
export async function runVehicleDriverClear(client, vehicleId, date, flags) {
    return client.post("/api/cli/driver/clear", { vehicleId, yyyymmdd: toYyyymmdd(date) }, { headers: writeFlagsToHeaders(flags) });
}
// ─── default (standing) driver — the vehicle.defaultKuski_personId attribute ──
/**
 * Read a vehicle's STANDING default driver (`vehicle.defaultKuski_personId`),
 * distinct from the per-day driver. Reuses the vehicle record (GET
 * /api/cli/vehicle/get/:id) and projects the default-driver pointer.
 */
export async function runVehicleDefaultGet(client, vehicleId) {
    const row = await client.get(`/api/cli/vehicle/get/${vehicleId}`);
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
export async function runVehicleDefaultSet(client, vehicleId, personId, flags) {
    return client.post("/api/vehicle/setDefaultPumppari", { vehicleId, personId }, { headers: writeFlagsToHeaders(flags) });
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
export function registerVehicleDriverCommands(parent, getClient) {
    const driver = parent
        .command("driver")
        .description("Vehicle drivers: day-driver dispatch (board/gaps/available/who/assign/clear/history) + the standing default driver");
    // ── fleet / day planning reads (date-keyed) ──
    driver
        .command("board <date>")
        .action(jsonAction(getClient, (client, date) => runVehicleDriverBoard(client, date)));
    driver
        .command("gaps <date>")
        .action(jsonAction(getClient, (client, date) => runVehicleDriverGaps(client, date)));
    driver
        .command("available <date>")
        .action(jsonAction(getClient, (client, date) => runVehicleDriverAvailable(client, date)));
    // ── per-vehicle day-driver ──
    driver
        .command("who <vehicleId> <date>")
        .action(jsonAction(getClient, (client, vehicleIdStr, date) => runVehicleDriverWho(client, parseId(vehicleIdStr, "vehicleId"), date)));
    driver
        .command("history <vehicleId>")
        .requiredOption("--from <date>")
        .requiredOption("--to <date>")
        .action(jsonAction(getClient, (client, vehicleIdStr, opts) => runVehicleDriverHistory(client, parseId(vehicleIdStr, "vehicleId"), opts)));
    addWriteFlagsToCommand(driver
        .command("assign <vehicleId> <date>")
        .requiredOption("--person <pid>", "", (s) => Number(s))).action(guarded(async (vehicleIdStr, date, opts) => {
        writeJson(await runVehicleDriverAssign(await getClient(), parseId(vehicleIdStr, "vehicleId"), opts.person, date, opts));
    }));
    addWriteFlagsToCommand(driver
        .command("clear <vehicleId> <date>")).action(guarded(async (vehicleIdStr, date, opts) => {
        writeJson(await runVehicleDriverClear(await getClient(), parseId(vehicleIdStr, "vehicleId"), date, opts));
    }));
    // ── standing default driver ──
    const def = driver
        .command("default")
        .description("The vehicle's STANDING default driver (vehicle.defaultKuski_personId)");
    def
        .command("get <vehicleId>")
        .action(jsonAction(getClient, (client, vehicleIdStr) => runVehicleDefaultGet(client, parseId(vehicleIdStr, "vehicleId"))));
    addWriteFlagsToCommand(def
        .command("set <vehicleId>")
        .requiredOption("--person <pid>", "", (s) => Number(s))).action(guarded(async (vehicleIdStr, opts) => {
        writeJson(await runVehicleDefaultSet(await getClient(), parseId(vehicleIdStr, "vehicleId"), opts.person, opts));
    }));
    addWriteFlagsToCommand(def
        .command("clear <vehicleId>")).action(guarded(async (vehicleIdStr, opts) => {
        writeJson(await runVehicleDefaultSet(await getClient(), parseId(vehicleIdStr, "vehicleId"), null, opts));
    }));
}
//# sourceMappingURL=driver.js.map