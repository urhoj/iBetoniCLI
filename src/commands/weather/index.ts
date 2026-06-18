import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { parseId } from "../../targets.js";

/** Expand `now` to the current ISO timestamp; pass any other value through. */
function resolveTime(input: string): string {
  return input === "now" ? new Date().toISOString() : input;
}

export interface WeatherPoint {
  lat: number;
  lng: number;
  time: string;
}

/**
 * GET /api/weather/forecast/:lat/:lng/:time — single-point FMI forecast.
 * Requires the company `weather` module (403 otherwise). Returns the flat
 * backend record as-is.
 */
export async function runWeatherForecast(
  client: ApiClient,
  opts: WeatherPoint
): Promise<Record<string, unknown>> {
  const time = encodeURIComponent(resolveTime(opts.time));
  return client.get<Record<string, unknown>>(
    `/api/weather/forecast/${opts.lat}/${opts.lng}/${time}`
  );
}

/**
 * GET /api/weather/day/:lat/:lng/:date — daily aggregate forecast.
 * Accepts relative date aliases (today/tomorrow/yesterday) via resolveDate.
 */
export async function runWeatherDay(
  client: ApiClient,
  opts: { lat: number; lng: number; date: string }
): Promise<Record<string, unknown>> {
  const date = resolveDate(opts.date) ?? opts.date;
  return client.get<Record<string, unknown>>(
    `/api/weather/day/${opts.lat}/${opts.lng}/${encodeURIComponent(date)}`
  );
}

/**
 * GET /api/weather/pumping-period/:lat/:lng/:pumppuAika/:pumppuKesto —
 * weather over a concrete-pumping window. pumppuKesto is in minutes.
 */
export async function runWeatherPumping(
  client: ApiClient,
  opts: { lat: number; lng: number; start: string; duration: number; keikka?: number }
): Promise<Record<string, unknown>> {
  const start = encodeURIComponent(resolveTime(opts.start));
  const qs = opts.keikka !== undefined ? `?keikkaId=${opts.keikka}` : "";
  return client.get<Record<string, unknown>>(
    `/api/weather/pumping-period/${opts.lat}/${opts.lng}/${start}/${opts.duration}${qs}`
  );
}

/**
 * POST /api/weather/tyomaa/:tyomaaId — forecast for a worksite by id.
 * The backend resolves coordinates from the worksite internally.
 */
export async function runWeatherWorksite(
  client: ApiClient,
  tyomaaId: number,
  forceRefresh: boolean
): Promise<Record<string, unknown>> {
  return client.post<Record<string, unknown>>(
    `/api/weather/tyomaa/${tyomaaId}`,
    { forceRefresh }
  );
}

/**
 * Pull lat/lng out of whatever shape getLatLng returns; throw exit 5 if absent.
 * The geocode controller returns raw Google Maps data:
 *   success: { status: "OK", results: [{ geometry: { location: { lat, lng } } }] }
 *   failure: { status: "ZERO_RESULTS" } or { status: "REQUEST_DENIED" } etc.
 * The plan's extractor also handles a normalized { lat, lng } top-level shape as
 * a fallback in case the response is pre-processed.
 */
function extractLatLng(geo: unknown): { lat: number; lng: number } {
  const g = geo as Record<string, unknown>;
  // Try normalized top-level lat/lng first (defensive fallback)
  const topLat = typeof g?.lat === "number" ? (g.lat as number) : undefined;
  const topLng = typeof g?.lng === "number" ? (g.lng as number) : undefined;
  if (topLat !== undefined && topLng !== undefined) {
    return { lat: topLat, lng: topLng };
  }
  // Standard Google Maps shape: results[0].geometry.location
  const results = g?.results as Array<Record<string, unknown>> | undefined;
  const loc = results?.[0]?.geometry as Record<string, unknown> | undefined;
  const location = loc?.location as Record<string, unknown> | undefined;
  const lat = typeof location?.lat === "number" ? (location.lat as number) : undefined;
  const lng = typeof location?.lng === "number" ? (location.lng as number) : undefined;
  if (lat !== undefined && lng !== undefined) {
    return { lat, lng };
  }
  throw new CliError(
    `Could not geocode address (status: ${(g?.status as string) ?? "unknown"})`,
    404,
    geo,
    5
  );
}

/**
 * POST /api/geocode/getLatLng { osoite } → extract lat/lng → runWeatherForecast.
 * Throws CliError(exit 5) if the address cannot be geocoded.
 */
export async function runWeatherAddress(
  client: ApiClient,
  opts: { address: string; time: string }
): Promise<Record<string, unknown>> {
  const geo = await client.post<unknown>("/api/geocode/getLatLng", {
    osoite: opts.address,
  });
  const { lat, lng } = extractLatLng(geo);
  return runWeatherForecast(client, { lat, lng, time: opts.time });
}

/**
 * GET /api/weather/module/status — whether the weather module is enabled.
 * No weather module guard on this endpoint (it would be a circular dependency).
 */
export async function runWeatherStatus(
  client: ApiClient
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>("/api/weather/module/status");
}

/**
 * POST /api/weather/module/toggle { enabled } — enable/disable the weather module.
 * Admin-scoped. Accepts write flags for dry-run / idempotency / audit trail.
 */
export async function runWeatherToggle(
  client: ApiClient,
  enabled: boolean,
  flags: WriteFlags
): Promise<Record<string, unknown>> {
  return client.post<Record<string, unknown>>(
    "/api/weather/module/toggle",
    { enabled },
    { headers: writeFlagsToHeaders(flags) }
  );
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
export function registerWeatherCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const w = parent
    .command("weather")
    .description("FMI weather forecasts (requires the company weather module)");

  w.command("forecast")
    .description("Point forecast for a lat/lng at a given time")
    .requiredOption("--lat <n>", "Latitude (Finland: 59.5–70.1)", Number)
    .requiredOption("--lng <n>", "Longitude (Finland: 19.0–31.6)", Number)
    .requiredOption("--time <iso>", "Forecast time (ISO 8601, or 'now')")
    .action(async (opts: { lat: number; lng: number; time: string }) => {
      try {
        const client = await getClient();
        writeJson(await runWeatherForecast(client, opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  w.command("day")
    .description("Daily aggregate forecast (min/max/avg temp, wind, precipitation)")
    .requiredOption("--lat <n>", "Latitude", Number)
    .requiredOption("--lng <n>", "Longitude", Number)
    .requiredOption("--date <d>", "Date (YYYY-MM-DD, or today/tomorrow)")
    .action(async (opts: { lat: number; lng: number; date: string }) => {
      try {
        const client = await getClient();
        writeJson(await runWeatherDay(client, opts));
      } catch (e) {
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
    .action(
      async (opts: {
        lat: number;
        lng: number;
        start: string;
        duration: number;
        keikka?: number;
      }) => {
        try {
          const client = await getClient();
          writeJson(await runWeatherPumping(client, opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  w.command("worksite <tyomaaId>")
    .description("Forecast for a worksite (resolves coordinates from the tyomaa)")
    .option("--force-refresh", "Bypass the cache and refetch from FMI")
    .action(async (idStr: string, opts: { forceRefresh?: boolean }) => {
      try {
        const client = await getClient();
        writeJson(await runWeatherWorksite(client, parseId(idStr, "tyomaaId"), !!opts.forceRefresh));
      } catch (e) {
        exitWithError(e);
      }
    });

  w.command("address")
    .description("Point forecast for a street address (geocodes via Google, then FMI)")
    .requiredOption("--address <s>", "Street address (min 5 chars)")
    .requiredOption("--time <iso>", "Forecast time (ISO 8601, or 'now')")
    .action(async (opts: { address: string; time: string }) => {
      try {
        const client = await getClient();
        writeJson(await runWeatherAddress(client, opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  w.command("status")
    .description("Whether the weather module is enabled for the active company")
    .action(async () => {
      try {
        writeJson(await runWeatherStatus(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  const toggleCmd = w
    .command("toggle")
    .description("Enable/disable the weather module (admin)")
    .option("--on", "Enable the module")
    .option("--off", "Disable the module");
  addWriteFlagsToCommand(toggleCmd).action(
    async (opts: {
      on?: boolean;
      off?: boolean;
      dryRun?: boolean;
      idempotencyKey?: string;
      reason?: string;
    }) => {
      // Covers both "neither" and "both" — failWith keeps the envelope honest
      // (statusCode 0: no HTTP request happened) and matches the spec's exit-4
      // row so the remedy surfaces as the envelope hint.
      if (!!opts.on === !!opts.off) {
        failWith("Pass exactly one of --on / --off", 4);
      }
      try {
        const client = await getClient();
        writeJson(
          await runWeatherToggle(client, !!opts.on, {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
