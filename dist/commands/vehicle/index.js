import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { CliError } from "../../api/errors.js";
import { diffFields } from "../../diff.js";
/**
 * Parse a CLI boolean flag value. Accepts true/1/yes/on (case-insensitive) as
 * true; everything else is false. Used by `--show-in-grid <bool>`.
 */
function parseBoolFlag(s) {
    return /^(true|1|yes|on)$/i.test(s.trim());
}
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
 * GET /api/cli/vehicle/types — list selectable vehicle types
 * (vehicleTypeId + name) for the active company, in the list envelope shape.
 */
export async function runVehicleTypes(client) {
    return client.get("/api/cli/vehicle/types");
}
/**
 * GET /api/cli/vehicle/list?search=…&limit=… — substring search over the
 * vehicle list (reg-no / name). Reuses the list endpoint with a `search`
 * query param; `limit` is appended only when supplied.
 */
export async function runVehicleSearch(client, query, limit) {
    const params = new URLSearchParams({ search: query });
    if (limit !== undefined)
        params.set("limit", String(limit));
    return client.get(`/api/cli/vehicle/list?${params.toString()}`);
}
/**
 * GET /api/cli/vehicle/dates/:vehicleId — a vehicle's inspection/cert dates
 * (e.g. katsastus, vakuutus) in the list envelope shape.
 */
export async function runVehicleDatesList(client, vehicleId) {
    return client.get(`/api/cli/vehicle/dates/${vehicleId}`);
}
/**
 * GET /api/cli/vehicle/dates/expiring — inspection/cert dates expiring within
 * the next `days` window across the whole fleet. `days` is appended as a query
 * param only when supplied (backend default applies otherwise, typically 30).
 */
export async function runVehicleDatesExpiring(client, days) {
    const qs = days !== undefined ? `?days=${days}` : "";
    return client.get(`/api/cli/vehicle/dates/expiring${qs}`);
}
/**
 * Writable columns compared for the `vehicle update --dry-run` field-level diff.
 * Read-only / system columns (sortNo, isRestricted, visibility, etc.) are
 * intentionally excluded — they are carried through unchanged and are not
 * settable from the CLI.
 */
const VEHICLE_DIFF_FIELDS = [
    "asiakasId",
    "vehicleNo",
    "vehicleNimi",
    "vehicleRegNo",
    "firstDate",
    "lastDate",
    "vehicleTypeId",
    "memo",
    "showInGrid",
    "defaultKuski_personId",
    "vehicleM3",
];
/**
 * Create a vehicle. The backend `vehicle_save` proc is UPDATE-only, so creation
 * is two-step: `POST /api/vehicle/new/:ownerAsiakasId` inserts a blank stub and
 * returns its `vehicleId`, then `POST /api/vehicle/save` populates it.
 *
 * `ownerAsiakasId` is taken from the active JWT. For a dry-run we only hit the
 * `/new` endpoint (with `X-Dry-Run`) and return the backend's preview — no save
 * is attempted. The `--reason` audit string is sent on both calls; the
 * `--idempotency-key` only applies to the populating save.
 */
export async function runVehicleCreate(client, fields, flags) {
    const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken());
    if (flags.dryRun) {
        return client.post(`/api/vehicle/new/${ownerAsiakasId}`, {}, { headers: writeFlagsToHeaders(flags) });
    }
    const created = await client.post(`/api/vehicle/new/${ownerAsiakasId}`, {}, { headers: writeFlagsToHeaders({ reason: flags.reason }) });
    const body = {
        vehicleId: created.vehicleId,
        asiakasId: fields.asiakasId ?? ownerAsiakasId,
        vehicleNo: fields.vehicleNo ?? null,
        vehicleNimi: fields.vehicleNimi ?? null,
        vehicleRegNo: fields.vehicleRegNo ?? null,
        vehicleTypeId: fields.vehicleTypeId ?? null,
        memo: fields.memo ?? null,
        defaultKuski_personId: fields.defaultKuski_personId ?? null,
        vehicleM3: fields.vehicleM3 ?? null,
    };
    return client.post("/api/vehicle/save", body, {
        headers: writeFlagsToHeaders({
            idempotencyKey: flags.idempotencyKey,
            reason: flags.reason,
        }),
    });
}
/**
 * Update a vehicle via read-merge-write: GET the full current row from the MAIN
 * `/api/vehicle/get/:id` endpoint (returns an array), overlay only the provided
 * `changes`, and POST the complete body to `/api/vehicle/save` (the proc expects
 * every column). Throws a 404 {@link CliError} (exit 5) when the vehicle is
 * absent so the caller surfaces "not found" rather than a malformed save.
 *
 * `--dry-run` is resolved entirely client-side (the save route ignores
 * `X-Dry-Run`): it returns `{ dryRun: true, vehicleId, wouldChange:{ field:{
 * from, to } } }` — the field-level diff of what would change — and never
 * POSTs. Because no write leaves the process the preview cannot persist; the
 * trade-off is it skips backend-side validation (the real save still validates).
 */
export async function runVehicleUpdate(client, vehicleId, changes, flags) {
    const rows = await client.get(`/api/vehicle/get/${vehicleId}`);
    const current = Array.isArray(rows)
        ? rows[0]
        : rows;
    if (!current) {
        throw new CliError(`Vehicle ${vehicleId} not found`, 404, null, 5);
    }
    const body = {
        vehicleId,
        asiakasId: changes.asiakasId ?? current.asiakasId,
        vehicleNo: changes.vehicleNo ?? current.vehicleNo,
        vehicleNimi: changes.vehicleNimi ?? current.vehicleNimi,
        vehicleRegNo: changes.vehicleRegNo ?? current.vehicleRegNo,
        vehiclePuomi: current.vehiclePuomi,
        firstDate: changes.firstDate ?? current.firstDate,
        lastDate: changes.lastDate ?? current.lastDate,
        vehicleTypeId: changes.vehicleTypeId ?? current.vehicleTypeId,
        memo: changes.memo ?? current.memo,
        sortNo: current.sortNo,
        showInGrid: changes.showInGrid ?? current.showInGrid,
        defaultKuski_personId: changes.defaultKuski_personId ?? current.defaultKuski_personId,
        useNoDriverBar: current.useNoDriverBar,
        showInReports: current.showInReports,
        tuoteId: current.tuoteId,
        isRestricted: current.isRestricted,
        multiTenantVisibility: current.multiTenantVisibility,
        defaultVisibilityAsiakasIds: current.defaultVisibilityAsiakasIds,
        hasGpsTracking: current.hasGpsTracking,
        vehicleM3: changes.vehicleM3 ?? current.vehicleM3,
    };
    // The /api/vehicle/save route does not honour X-Dry-Run server-side, so the
    // preview is computed entirely client-side — it cannot persist. Report the
    // field-level diff (what would actually change) rather than the whole body.
    if (flags.dryRun) {
        return {
            dryRun: true,
            vehicleId,
            wouldChange: diffFields(current, body, VEHICLE_DIFF_FIELDS),
        };
    }
    return client.post("/api/vehicle/save", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Assign a per-day driver to a vehicle (vehicleDriverDays). The date flag is
 * resolved through {@link resolveDate} (today/yesterday/tomorrow aliases) and
 * collapsed to the backend's integer `yyyymmdd` key. Write-safety flags
 * (--dry-run / --idempotency-key / --reason) map to headers as usual.
 */
export async function runVehicleDriversAssign(client, vehicleId, personId, date, flags) {
    const yyyymmdd = Number(resolveDate(date).replace(/-/g, ""));
    return client.post("/api/vehicle/driverDays/save", { vehicleId, personId, yyyymmdd }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Register every `ib vehicle` subcommand on the parent commander instance.
 *
 * Reads: list, get, search, types, status, drivers, dates (list/expiring),
 * and GPS/telemetry — locations, timeline, route, visits.
 * Writes: create, update, driver-assign (carry the --dry-run/--reason/-idempotency
 * write-safety flags).
 *
 * `src/reference/specs.ts` is the single source of truth for the authoritative
 * subcommand list, flags, permissions, and output shapes (also via
 * `ib vehicle --help` / `ib reference dump`) — keep this comment high-level so it
 * does not drift as commands are added.
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
 *
 * Exit codes: 1 = generic API/runtime failure (else the mapped CliError codes).
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
    v.command("types")
        .description("List vehicle types (vehicleTypeId + name)")
        .action(async () => {
        try {
            writeJson(await runVehicleTypes(await getClient()));
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
    v.command("search <query>")
        .description("Search vehicles by reg-no / name substring")
        .option("--limit <n>", "Max rows", (val) => Math.min(Number(val), 500))
        .action(async (query, opts) => {
        try {
            writeJson(await runVehicleSearch(await getClient(), query, opts.limit));
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
    const createCmd = v
        .command("create")
        .description("Create a vehicle (new stub then save). ownerAsiakasId from JWT.")
        .option("--reg <s>", "Registration number (vehicleRegNo)")
        .option("--name <s>", "Display name (vehicleNimi)")
        .option("--no <n>", "Fleet number (vehicleNo)", (s) => Number(s))
        .option("--type <n>", "vehicleTypeId (see `ib vehicle types`)", (s) => Number(s))
        .option("--memo <s>", "Free-text memo")
        .option("--default-driver <pid>", "Default driver personId", (s) => Number(s))
        .option("--capacity <m3>", "Concrete capacity in m3 (vehicleM3)", (s) => Number(s))
        .option("--asiakas <id>", "Owning asiakasId (defaults to active company)", (s) => Number(s));
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const result = await runVehicleCreate(await getClient(), {
                vehicleRegNo: opts.reg,
                vehicleNimi: opts.name,
                vehicleNo: opts.no,
                vehicleTypeId: opts.type,
                memo: opts.memo,
                defaultKuski_personId: opts.defaultDriver,
                vehicleM3: opts.capacity,
                asiakasId: opts.asiakas,
            }, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = v
        .command("update <vehicleId>")
        .description("Update a vehicle (read-merge-write; only provided flags change).")
        .option("--reg <s>", "Registration number (vehicleRegNo)")
        .option("--name <s>", "Display name (vehicleNimi)")
        .option("--no <n>", "Fleet number (vehicleNo)", (s) => Number(s))
        .option("--type <n>", "vehicleTypeId", (s) => Number(s))
        .option("--memo <s>", "Free-text memo")
        .option("--default-driver <pid>", "Default driver personId", (s) => Number(s))
        .option("--capacity <m3>", "Concrete capacity in m3 (vehicleM3)", (s) => Number(s))
        .option("--asiakas <id>", "Owning asiakasId", (s) => Number(s))
        .option("--show-in-grid <bool>", "Whether the vehicle appears in the grid (true/false)", parseBoolFlag)
        .option("--first-date <date>", "Start of validity window YYYY-MM-DD (firstDate; or today/yesterday/tomorrow)")
        .option("--last-date <date>", "End of validity window YYYY-MM-DD (lastDate; or today/yesterday/tomorrow)");
    addWriteFlagsToCommand(updateCmd).action(async (idStr, opts) => {
        try {
            const result = await runVehicleUpdate(await getClient(), Number(idStr), {
                vehicleRegNo: opts.reg,
                vehicleNimi: opts.name,
                vehicleNo: opts.no,
                vehicleTypeId: opts.type,
                memo: opts.memo,
                defaultKuski_personId: opts.defaultDriver,
                vehicleM3: opts.capacity,
                asiakasId: opts.asiakas,
                showInGrid: opts.showInGrid,
                firstDate: resolveDate(opts.firstDate),
                lastDate: resolveDate(opts.lastDate),
            }, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const dates = v
        .command("dates")
        .description("Vehicle inspection/cert date reads");
    dates
        .command("list <vehicleId>")
        .description("List a vehicle's dates")
        .action(async (idStr) => {
        try {
            writeJson(await runVehicleDatesList(await getClient(), Number(idStr)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    dates
        .command("expiring")
        .description("List expiring vehicle dates across the fleet")
        .option("--days <n>", "Days-ahead window (default 30)", (s) => Number(s))
        .action(async (opts) => {
        try {
            writeJson(await runVehicleDatesExpiring(await getClient(), opts.days));
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
    const assignCmd = v
        .command("driver-assign <vehicleId>")
        .description("Assign a per-day driver to a vehicle (vehicleDriverDays)")
        .requiredOption("--person <pid>", "Driver personId", (s) => Number(s))
        .option("--date <d>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)", "today");
    addWriteFlagsToCommand(assignCmd).action(async (idStr, opts) => {
        try {
            const result = await runVehicleDriversAssign(await getClient(), Number(idStr), opts.person, opts.date, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
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