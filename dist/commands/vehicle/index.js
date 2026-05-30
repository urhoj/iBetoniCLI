import { writeJson, writeError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=index.js.map