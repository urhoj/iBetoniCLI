import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { parseId } from "../../targets.js";
import { runKeikkaGet } from "../keikka/index.js";
import { guarded, jsonAction } from "../_shared/action.js";

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
 * GET /api/geocode/sijainti/get/:sijaintiId → coords → forecast. Sijainti rows
 * (depots/plants) are cross-tenant readable. Throws exit 5 when the sijainti is
 * missing or has no GPS pin.
 */
export async function runWeatherSijainti(
  client: ApiClient,
  sijaintiId: number,
  time: string
): Promise<Record<string, unknown>> {
  const s = await client.get<Record<string, unknown>>(
    `/api/geocode/sijainti/get/${sijaintiId}`
  );
  const lat = Number(s?.lat);
  const lng = Number(s?.lng);
  if (!s || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    // Client-origin: the GET succeeded, the row just carries no pin. The spec's
    // `http: 404` row still covers the server's "no such sijainti"; its remedy's
    // applicable half rides along here so this branch keeps its hint.
    failWith(
      `sijainti ${sijaintiId} has no coordinates`,
      5,
      "ensure the location has a GPS pin (`ib sijainti list`)"
    );
  }
  return runWeatherForecast(client, { lat, lng, time });
}

/**
 * GET /api/cli/keikka/get/:keikkaId → worksite.tyomaaId → POST
 * /api/weather/tyomaa/:tyomaaId (the same path `worksite` uses). A keikka's
 * location is its worksite. Throws exit 5 when the keikka has no worksite.
 */
export async function runWeatherKeikka(
  client: ApiClient,
  keikkaId: number,
  forceRefresh: boolean
): Promise<Record<string, unknown>> {
  const k = await runKeikkaGet(client, keikkaId);
  const tyomaaId = (k?.worksite as { tyomaaId?: number } | null)?.tyomaaId;
  if (!tyomaaId) {
    failWith(
      `keikka ${keikkaId} has no worksite to resolve coordinates from`,
      5,
      "the keikka must have a worksite with coordinates"
    );
  }
  return runWeatherWorksite(client, tyomaaId, forceRefresh);
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
  failWith(
    `Could not geocode address (status: ${(g?.status as string) ?? "unknown"})`,
    5,
    "try a more specific Finnish address"
  );
}

/**
 * POST /api/geocode/getLatLng { osoite } → extract lat/lng → runWeatherForecast.
 * Exits 5 (client-origin) if the address cannot be geocoded.
 *
 * The geocode is marked `read: true` — a POST only because the address travels
 * in the body — so a forecast lookup is not refused by the `--read-only`
 * write-lock and does not print the acting-as write banner.
 */
export async function runWeatherAddress(
  client: ApiClient,
  opts: { address: string; time: string }
): Promise<Record<string, unknown>> {
  const geo = await client.post<unknown>(
    "/api/geocode/getLatLng",
    { osoite: opts.address },
    { read: true }
  );
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
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  // Canonical home is `ib opendata weather`; the top-level `ib weather` is
  // registered with { hidden: true } as a back-compat alias (runtime-only,
  // absent from spec-driven discovery and root --help).
  const w = parent
    .command("weather", { hidden: !!opts.hidden })
    .description("FMI weather forecasts (requires the company weather module)");

  w.command("forecast")
    .description("Point forecast for a lat/lng at a given time")
    .requiredOption("--lat <n>", "", Number)
    .requiredOption("--lng <n>", "", Number)
    .requiredOption("--time <iso>")
    .action(
      jsonAction(getClient, (client, opts: { lat: number; lng: number; time: string }) =>
        runWeatherForecast(client, opts)
      )
    );

  w.command("day")
    .description("Daily aggregate forecast (min/max/avg temp, wind, precipitation)")
    .requiredOption("--lat <n>", "", Number)
    .requiredOption("--lng <n>", "", Number)
    .requiredOption("--date <d>")
    .action(
      jsonAction(getClient, (client, opts: { lat: number; lng: number; date: string }) =>
        runWeatherDay(client, opts)
      )
    );

  w.command("pumping")
    .description("Weather over a concrete-pumping window (start + duration minutes)")
    .requiredOption("--lat <n>", "", Number)
    .requiredOption("--lng <n>", "", Number)
    .requiredOption("--start <iso>")
    .requiredOption("--duration <min>", "", Number)
    .option("--keikka <id>", "", Number)
    .action(
      jsonAction(getClient, (client, opts: { lat: number; lng: number; start: string; duration: number; keikka?: number; }) =>
        runWeatherPumping(client, opts)
      )
    );

  w.command("worksite <tyomaaId>")
    .description("Forecast for a worksite (resolves coordinates from the tyomaa)")
    .option("--force-refresh")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { forceRefresh?: boolean }) =>
        runWeatherWorksite(client, parseId(idStr, "tyomaaId"), !!opts.forceRefresh)
      )
    );

  w.command("sijainti <sijaintiId>")
    .description("Point forecast for a sijainti (resolves coordinates from the location)")
    .option("--time <iso>", "", "now")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { time: string }) =>
        runWeatherSijainti(client, parseId(idStr, "sijaintiId"), opts.time)
      )
    );

  w.command("keikka <keikkaId>")
    .description("Forecast for a keikka (resolves coordinates from its worksite)")
    .option("--force-refresh")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { forceRefresh?: boolean }) =>
        runWeatherKeikka(client, parseId(idStr, "keikkaId"), !!opts.forceRefresh)
      )
    );

  w.command("address")
    .description("Point forecast for a street address (geocodes via Google, then FMI)")
    .requiredOption("--address <s>")
    .requiredOption("--time <iso>")
    .action(
      jsonAction(getClient, (client, opts: { address: string; time: string }) =>
        runWeatherAddress(client, opts)
      )
    );

  w.command("status")
    .description("Whether the weather module is enabled for the active company")
    .action(jsonAction(getClient, runWeatherStatus));

  const toggleCmd = w
    .command("toggle")
    .description("Enable/disable the weather module (admin)")
    .option("--on")
    .option("--off");
  addWriteFlagsToCommand(toggleCmd).action(
    guarded(async (opts: WriteFlags & { on?: boolean; off?: boolean }) => {
      // Covers both "neither" and "both" — failWith keeps the envelope honest
      // (statusCode 0: no HTTP request happened) and matches the spec's exit-4
      // row so the remedy surfaces as the envelope hint.
      if (!!opts.on === !!opts.off) {
        failWith("Pass exactly one of --on / --off", 4);
      }
      const client = await getClient();
      writeJson(await runWeatherToggle(client, !!opts.on, opts));
    })
  );
}
