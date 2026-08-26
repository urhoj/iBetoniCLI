import { writeJson } from "../../output/json.js";
import { resolveDate, toYyyymmddInt } from "../../dates.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { parseId, resolveDateInput } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
import { markPlaceholderVehicles } from "./placeholder.js";
// ─── day-driver reads (date-keyed fleet views + per-vehicle) ─────────────────
async function fetchDriverBoard(client, date) {
    return markPlaceholderVehicles(await client.get(`/api/cli/driver/board/${toYyyymmddInt(date)}`));
}
/**
 * What "grid-eligible" MEANS — the compound rule the board/gaps help used to
 * name without defining (fb#776). A vehicle whose lastDate has passed never
 * reaches the board, which is exactly the case an empty list must expose.
 */
const GRID_ELIGIBLE_DEF = "grid-eligible = the vehicle's showInGrid is set AND the date falls inside its firstDate..lastDate window";
/**
 * Empty-state disambiguation for `board`/`gaps` (fb#776). An empty list
 * conflates two very different situations — 'every grid-eligible vehicle
 * already has a driver' (nothing to do) and 'no vehicle is grid-eligible on
 * this date' (the question could not be asked) — and a cold-start agent read
 * the second as the first. The counts alone resolve it, so the envelope's
 * `hint` carries them; stdout shape is otherwise untouched. Fail-safe: the
 * extra fetches must never break the command they annotate — on any failure
 * the hint degrades to the bare definition. `knownBoardCount` lets `board`
 * pass its own (zero) count instead of re-fetching.
 */
async function emptyDayHint(client, date, knownBoardCount) {
    try {
        const boardCount = knownBoardCount ?? (await fetchDriverBoard(client, date)).items.length;
        if (boardCount > 0)
            return `no gaps: all ${boardCount} grid-eligible vehicles already have a driver on ${date} — nothing to fill (${GRID_ELIGIBLE_DEF})`;
        const fleet = await client.get(`/api/cli/vehicle/list${qs({ limit: 500 })}`);
        const fleetCount = fleet?.truncated ? `at least ${fleet?.count ?? 0}` : `${fleet?.count ?? 0}`;
        return `no rows: NO vehicle is grid-eligible on ${date}, though the fleet has ${fleetCount} vehicles — ${GRID_ELIGIBLE_DEF}. A vehicle whose lastDate has passed silently leaves the board; check \`ib vehicle list\` for closed windows`;
    }
    catch {
        return `no rows — ${GRID_ELIGIBLE_DEF}. To tell 'everything eligible already has a driver' from 'nothing is eligible on this date', pair \`ib vehicle driver board ${date}\` with \`ib vehicle list\``;
    }
}
/**
 * GET /api/cli/driver/board/:yyyymmdd — every grid-eligible vehicle + driver/gap
 * + keikka load for a day. Sentinel rows are stamped `placeholder: true` so a
 * non-assignable legacy row isn't read as a driverless truck (fb#380).
 */
export async function runVehicleDriverBoard(client, date) {
    const env = await fetchDriverBoard(client, date);
    if (env.items.length === 0)
        env.hint = await emptyDayHint(client, date, 0);
    return env;
}
/**
 * GET /api/cli/driver/gaps/:yyyymmdd — vehicles needing a driver that day (the
 * "Ei kuljettajaa" list). Server-side these are the board rows filtered to
 * `needsDriver`, so they get the same placeholder stamp — a sentinel marked on
 * the board but bare here would be a contract the caller could trip on.
 */
export async function runVehicleDriverGaps(client, date) {
    const env = markPlaceholderVehicles(await client.get(`/api/cli/driver/gaps/${toYyyymmddInt(date)}`));
    if (env.items.length === 0)
        env.hint = await emptyDayHint(client, date);
    return env;
}
/** GET /api/cli/driver/available/:yyyymmdd — assignable drivers free + not absent that day. */
export async function runVehicleDriverAvailable(client, date) {
    return client.get(`/api/cli/driver/available/${toYyyymmddInt(date)}`);
}
/** GET /api/cli/driver/who/:vehicleId/:yyyymmdd — the day driver of one vehicle on a date. */
export async function runVehicleDriverWho(client, vehicleId, date) {
    return client.get(`/api/cli/driver/who/${vehicleId}/${toYyyymmddInt(date)}`);
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
    return client.post("/api/cli/driver/assign", { vehicleId, personId, yyyymmdd: toYyyymmddInt(date) }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/cli/driver/clear — remove the DAY driver from a vehicle for one date
 * (personId=null). Same atomic cascade as assign: clears the driver from that
 * day's keikkat/palkit and frees the person (personPvm.vehicleId=null) so they can
 * be reassigned. Returns the affected keikkaIds/palkkiIds + the displaced driver.
 */
export async function runVehicleDriverClear(client, vehicleId, date, flags) {
    return client.post("/api/cli/driver/clear", { vehicleId, yyyymmdd: toYyyymmddInt(date) }, { headers: writeFlagsToHeaders(flags) });
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
    // Every date-keyed leaf below takes its day EITHER positionally or as
    // `--date` (feedback #393): the sibling GPS reads (`vehicle timeline`/
    // `route`/`visits`) are flag-shaped, and an agent arriving from one of those
    // reached for `--date` here and burned an exit 4 on argument shape alone.
    // `resolveDateInput` enforces exactly-one and expands today/yesterday/tomorrow.
    const DATE_FLAG = "--date <date>";
    /**
     * `jsonAction` for a fleet-wide day read, with the date guard resolved BEFORE
     * `getClient()` (the ordering `sijainti closest` already uses): a bad or
     * missing date must exit 4 on its own terms rather than surfacing as an auth
     * failure the caller would fix first and only then learn the real problem.
     */
    const dayAction = (run) => guarded(async (date, opts) => {
        const day = resolveDateInput(date, opts.date);
        writeJson(await run(await getClient(), day));
    });
    // ── fleet / day planning reads (date-keyed) ──
    driver.command("board [date]").option(DATE_FLAG).action(dayAction(runVehicleDriverBoard));
    driver.command("gaps [date]").option(DATE_FLAG).action(dayAction(runVehicleDriverGaps));
    driver.command("available [date]").option(DATE_FLAG).action(dayAction(runVehicleDriverAvailable));
    // ── per-vehicle day-driver ──
    driver
        .command("who <vehicleId> [date]")
        .option(DATE_FLAG)
        .action(guarded(async (vehicleIdStr, date, opts) => {
        const vehicleId = parseId(vehicleIdStr, "vehicleId");
        const day = resolveDateInput(date, opts.date);
        writeJson(await runVehicleDriverWho(await getClient(), vehicleId, day));
    }));
    driver
        .command("history <vehicleId>")
        .requiredOption("--from <date>")
        .requiredOption("--to <date>")
        .action(jsonAction(getClient, (client, vehicleIdStr, opts) => runVehicleDriverHistory(client, parseId(vehicleIdStr, "vehicleId"), opts)));
    addWriteFlagsToCommand(driver
        .command("assign <vehicleId> [date]")
        .option(DATE_FLAG)
        .requiredOption("--person <pid>", "", (s) => Number(s))).action(guarded(async (vehicleIdStr, date, opts) => {
        const vehicleId = parseId(vehicleIdStr, "vehicleId");
        const day = resolveDateInput(date, opts.date);
        writeJson(await runVehicleDriverAssign(await getClient(), vehicleId, opts.person, day, opts));
    }));
    addWriteFlagsToCommand(driver
        .command("clear <vehicleId> [date]")
        .option(DATE_FLAG)).action(guarded(async (vehicleIdStr, date, opts) => {
        const vehicleId = parseId(vehicleIdStr, "vehicleId");
        const day = resolveDateInput(date, opts.date);
        writeJson(await runVehicleDriverClear(await getClient(), vehicleId, day, opts));
    }));
    // ── standing default driver ──
    const def = driver
        .command("default")
        .description("The vehicle's STANDING default driver (vehicle.defaultKuski_personId)");
    def
        .command("get <vehicleId>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
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