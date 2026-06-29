import { CliError } from "../../api/errors.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { parseId } from "../../targets.js";
/** Expand `now` to the current ISO timestamp; pass any other value through. */
function resolveTime(input) {
    return input === "now" ? new Date().toISOString() : input;
}
/**
 * GET /api/weather/forecast/:lat/:lng/:time — single-point FMI forecast.
 * Requires the company `weather` module (403 otherwise). Returns the flat
 * backend record as-is.
 */
export async function runWeatherForecast(client, opts) {
    const time = encodeURIComponent(resolveTime(opts.time));
    return client.get(`/api/weather/forecast/${opts.lat}/${opts.lng}/${time}`);
}
/**
 * GET /api/weather/day/:lat/:lng/:date — daily aggregate forecast.
 * Accepts relative date aliases (today/tomorrow/yesterday) via resolveDate.
 */
export async function runWeatherDay(client, opts) {
    const date = resolveDate(opts.date) ?? opts.date;
    return client.get(`/api/weather/day/${opts.lat}/${opts.lng}/${encodeURIComponent(date)}`);
}
/**
 * GET /api/weather/pumping-period/:lat/:lng/:pumppuAika/:pumppuKesto —
 * weather over a concrete-pumping window. pumppuKesto is in minutes.
 */
export async function runWeatherPumping(client, opts) {
    const start = encodeURIComponent(resolveTime(opts.start));
    const qs = opts.keikka !== undefined ? `?keikkaId=${opts.keikka}` : "";
    return client.get(`/api/weather/pumping-period/${opts.lat}/${opts.lng}/${start}/${opts.duration}${qs}`);
}
/**
 * POST /api/weather/tyomaa/:tyomaaId — forecast for a worksite by id.
 * The backend resolves coordinates from the worksite internally.
 */
export async function runWeatherWorksite(client, tyomaaId, forceRefresh) {
    return client.post(`/api/weather/tyomaa/${tyomaaId}`, { forceRefresh });
}
/**
 * Pull lat/lng out of whatever shape getLatLng returns; throw exit 5 if absent.
 * The geocode controller returns raw Google Maps data:
 *   success: { status: "OK", results: [{ geometry: { location: { lat, lng } } }] }
 *   failure: { status: "ZERO_RESULTS" } or { status: "REQUEST_DENIED" } etc.
 * The plan's extractor also handles a normalized { lat, lng } top-level shape as
 * a fallback in case the response is pre-processed.
 */
function extractLatLng(geo) {
    const g = geo;
    // Try normalized top-level lat/lng first (defensive fallback)
    const topLat = typeof g?.lat === "number" ? g.lat : undefined;
    const topLng = typeof g?.lng === "number" ? g.lng : undefined;
    if (topLat !== undefined && topLng !== undefined) {
        return { lat: topLat, lng: topLng };
    }
    // Standard Google Maps shape: results[0].geometry.location
    const results = g?.results;
    const loc = results?.[0]?.geometry;
    const location = loc?.location;
    const lat = typeof location?.lat === "number" ? location.lat : undefined;
    const lng = typeof location?.lng === "number" ? location.lng : undefined;
    if (lat !== undefined && lng !== undefined) {
        return { lat, lng };
    }
    throw new CliError(`Could not geocode address (status: ${g?.status ?? "unknown"})`, 404, geo, 5);
}
/**
 * POST /api/geocode/getLatLng { osoite } → extract lat/lng → runWeatherForecast.
 * Throws CliError(exit 5) if the address cannot be geocoded.
 */
export async function runWeatherAddress(client, opts) {
    const geo = await client.post("/api/geocode/getLatLng", {
        osoite: opts.address,
    });
    const { lat, lng } = extractLatLng(geo);
    return runWeatherForecast(client, { lat, lng, time: opts.time });
}
/**
 * GET /api/weather/module/status — whether the weather module is enabled.
 * No weather module guard on this endpoint (it would be a circular dependency).
 */
export async function runWeatherStatus(client) {
    return client.get("/api/weather/module/status");
}
/**
 * POST /api/weather/module/toggle { enabled } — enable/disable the weather module.
 * Admin-scoped. Accepts write flags for dry-run / idempotency / audit trail.
 */
export async function runWeatherToggle(client, enabled, flags) {
    return client.post("/api/weather/module/toggle", { enabled }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Register all `ib weather` subcommands:
 *   forecast   GET /api/weather/forecast/:lat/:lng/:time
 *   day        GET /api/weather/day/:lat/:lng/:date
 *   pumping    GET /api/weather/pumping-period/:lat/:lng/:start/:duration
 *   worksite   POST /api/weather/tyomaa/:tyomaaId
 *   address    POST /api/geocode/getLatLng → GET /api/weather/forecast
 *   status     GET /api/weather/module/status
 *   toggle     POST /api/weather/module/toggle
 */
export function registerWeatherCommands(parent, getClient, opts = {}) {
    // Canonical home is `ib opendata weather`; the top-level `ib weather` is
    // registered with { hidden: true } as a back-compat alias (runtime-only,
    // absent from spec-driven discovery and root --help).
    const w = parent
        .command("weather", { hidden: !!opts.hidden })
        .description("FMI weather forecasts (requires the company weather module)");
    w.command("forecast")
        .description("Point forecast for a lat/lng at a given time")
        .requiredOption("--lat <n>", "Latitude (Finland: 59.5–70.1)", Number)
        .requiredOption("--lng <n>", "Longitude (Finland: 19.0–31.6)", Number)
        .requiredOption("--time <iso>", "Forecast time (ISO 8601, or 'now')")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runWeatherForecast(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    w.command("day")
        .description("Daily aggregate forecast (min/max/avg temp, wind, precipitation)")
        .requiredOption("--lat <n>", "Latitude", Number)
        .requiredOption("--lng <n>", "Longitude", Number)
        .requiredOption("--date <d>", "Date (YYYY-MM-DD, or today/tomorrow)")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runWeatherDay(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    w.command("pumping")
        .description("Weather over a concrete-pumping window (start + duration minutes)")
        .requiredOption("--lat <n>", "Latitude", Number)
        .requiredOption("--lng <n>", "Longitude", Number)
        .requiredOption("--start <iso>", "Pumping start (ISO 8601, or 'now')")
        .requiredOption("--duration <min>", "Pumping duration in minutes", Number)
        .option("--keikka <id>", "Keikka id (for backend error correlation only)", Number)
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runWeatherPumping(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    w.command("worksite <tyomaaId>")
        .description("Forecast for a worksite (resolves coordinates from the tyomaa)")
        .option("--force-refresh", "Bypass the cache and refetch from FMI")
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runWeatherWorksite(client, parseId(idStr, "tyomaaId"), !!opts.forceRefresh));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    w.command("address")
        .description("Point forecast for a street address (geocodes via Google, then FMI)")
        .requiredOption("--address <s>", "Street address (min 5 chars)")
        .requiredOption("--time <iso>", "Forecast time (ISO 8601, or 'now')")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runWeatherAddress(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    w.command("status")
        .description("Whether the weather module is enabled for the active company")
        .action(async () => {
        try {
            writeJson(await runWeatherStatus(await getClient()));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const toggleCmd = w
        .command("toggle")
        .description("Enable/disable the weather module (admin)")
        .option("--on", "Enable the module")
        .option("--off", "Disable the module");
    addWriteFlagsToCommand(toggleCmd).action(async (opts) => {
        // Covers both "neither" and "both" — failWith keeps the envelope honest
        // (statusCode 0: no HTTP request happened) and matches the spec's exit-4
        // row so the remedy surfaces as the envelope hint.
        if (!!opts.on === !!opts.off) {
            failWith("Pass exactly one of --on / --off", 4);
        }
        try {
            const client = await getClient();
            writeJson(await runWeatherToggle(client, !!opts.on, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map