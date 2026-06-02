import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
const VISIT_FILTER_TYPES = ["tyomaa", "sijainti"];
/**
 * GET /api/cli/vehicle/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runVehicleList(client, opts) {
    const params = new URLSearchParams();
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.cursor)
        params.set("cursor", opts.cursor);
    const qs = params.toString();
    return client.get(`/api/cli/vehicle/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/vehicle/get/:vehicleId. Returns the flat backend record as-is.
 */
export async function runVehicleGet(client, vehicleId) {
    return client.get(`/api/cli/vehicle/get/${vehicleId}`);
}
/**
 * GET /api/cli/vehicle/status/:vehicleId. Returns the flat status record:
 * current driver, current keikka, and latest GPS ping (or null fields).
 */
export async function runVehicleStatus(client, vehicleId) {
    return client.get(`/api/cli/vehicle/status/${vehicleId}`);
}
/**
 * GET /api/cli/vehicle/drivers/:vehicleId — driver-assignment history over a
 * date range. Date aliases (today/yesterday/tomorrow) are resolved before the
 * call; query params are appended only when set.
 */
export async function runVehicleDrivers(client, vehicleId, opts) {
    const params = new URLSearchParams();
    if (opts.from)
        params.set("from", opts.from);
    if (opts.to)
        params.set("to", opts.to);
    const qs = params.toString();
    return client.get(`/api/cli/vehicle/drivers/${vehicleId}${qs ? `?${qs}` : ""}`);
}
/** GET /api/cli/vehicle/locations — fleet-wide live position snapshot. */
export async function runVehicleLocations(client) {
    return client.get("/api/cli/vehicle/locations");
}
/** GET /api/cli/vehicle/timeline/:vehicleId?date= — per-day stop/travel segments. */
export async function runVehicleTimeline(client, vehicleId, opts) {
    const qs = opts.date ? `?date=${opts.date}` : "";
    return client.get(`/api/cli/vehicle/timeline/${vehicleId}${qs}`);
}
/** GET /api/cli/vehicle/route/:vehicleId?date= — per-day ordered GPS polyline. */
export async function runVehicleRoute(client, vehicleId, opts) {
    const qs = opts.date ? `?date=${opts.date}` : "";
    return client.get(`/api/cli/vehicle/route/${vehicleId}${qs}`);
}
/** GET /api/cli/vehicle/visits/:filterType/:filterId?days= — vehicles that visited a site. */
export async function runVehicleVisits(client, filterType, filterId, opts) {
    if (!VISIT_FILTER_TYPES.includes(filterType)) {
        throw new Error(`filterType must be one of: ${VISIT_FILTER_TYPES.join(", ")}`);
    }
    const qs = opts.days !== undefined ? `?days=${opts.days}` : "";
    return client.get(`/api/cli/vehicle/visits/${filterType}/${filterId}${qs}`);
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
export function registerVehicleCommands(parent, getClient) {
    const v = parent.command("vehicle").description("Vehicle commands");
    v.command("list")
        .description("List vehicles")
        .option("--limit <n>", "Max rows", (val) => Math.min(Number(val), 500))
        .option("--cursor <c>", "Pagination cursor")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runVehicleList(client, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("get <vehicleId>")
        .description("Get a single vehicle by vehicleId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runVehicleGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("status <vehicleId>")
        .description("Current driver, keikka, and latest GPS ping for a vehicle")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runVehicleStatus(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("drivers <vehicleId>")
        .description("Driver-assignment history for a vehicle within a date range")
        .option("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
        .option("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const result = await runVehicleDrivers(client, Number(idStr), {
                from: resolveDate(opts.from),
                to: resolveDate(opts.to),
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("locations")
        .description("Fleet-wide live GPS positions (current lat/lng + speed/heading/engine/address)")
        .action(async () => {
        try {
            const client = await getClient();
            writeJson(await runVehicleLocations(client));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("timeline <vehicleId>")
        .description("Per-day GPS timeline: named stops (sijainti/tyomaa) + travel legs with durations")
        .option("--date <date>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runVehicleTimeline(client, Number(idStr), { date: resolveDate(opts.date) }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("route <vehicleId>")
        .description("Per-day ordered GPS track points (polyline) for a vehicle")
        .option("--date <date>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runVehicleRoute(client, Number(idStr), { date: resolveDate(opts.date) }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    v.command("visits <filterType> <id>")
        .description("Vehicles that visited a worksite/location. filterType: tyomaa | sijainti")
        .option("--days <n>", "Look-back window in days (omit for all-time)", (val) => Number(val))
        .action(async (filterType, idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runVehicleVisits(client, filterType, Number(idStr), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map