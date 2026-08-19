// opendata specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, COMMON_AUTH_ERRORS } from "./shared.js";

export const OPENDATA_SPECS: CommandSpec[] = [

  // ─── opendata (12): free/open external data — building + parcel + weather + prh ────
  {
    command: "ib opendata building",
    description:
      "Look up building-registry data for a point anywhere in Finland. The metro-area WFS providers (Helsinki/Vantaa/Espoo/HSY) are tried first for their richer per-building detail; the NATIONAL Ryhti open dataset (SYKE) is a fallback so points outside the metro area still resolve (found:true with national:true). Resolve the point from EXACTLY ONE of: --sijainti, --worksite (alias --tyomaa), --lat+--lng, or --address. --city overrides the provider (pass Ryhti to force the national source); when omitted it is derived from the source or auto-tried (Helsinki→Vantaa→Espoo) then Ryhti. Read-only; any authenticated user. Worksite resolution is tenant-scoped; sijainti is cross-tenant readable; building data itself is public.",
    auth: "any",
    flags: [
      { name: "sijainti", type: "number", description: "Resolve coordinates from a sijainti id (cross-tenant readable)" },
      { name: "worksite", type: "number", description: "Resolve coordinates from a worksite (tyomaaId); tenant-scoped" },
      { name: "tyomaa", type: "number", description: "Alias for --worksite" },
      { name: "lat", type: "number", description: "Latitude (WGS84) — pair with --lng" },
      { name: "lng", type: "number", description: "Longitude (WGS84) — pair with --lat" },
      { name: "address", type: "string", description: "Street address to geocode (e.g. 'Mannerheimintie 1, Helsinki')" },
      { name: "city", type: "string", description: "Helsinki | Vantaa | Espoo | HSY | Ryhti (override; otherwise derived/auto-tried then national Ryhti fallback)" },
    ],
    outputShape:
      "{ source:'sijainti'|'worksite'|'address'|'coords', input, coords:{lat,lng}, city|null, requestedCity|null, derivedCity|null, found:boolean, outOfArea:boolean, national:boolean, building:{ buildingId, nationalBuildingId, buildingType, floors, totalArea, completionYear, facadeMaterial, … common schema }|null }",
    errors: [
      { origin: "client", exit: 4, meaning: "No source, multiple sources, or invalid city/coords", remedy: "pass exactly one of --sijainti / --worksite / --lat+--lng / --address; city must be Helsinki|Vantaa|Espoo|HSY|Ryhti" },
      apiErr(404, "Sijainti/worksite not found (or no coordinates), or address not geocodable", "verify the id/address; a worksite must be geocoded and in your tenant"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "national:true → the building came from the national Ryhti dataset (used when the metro WFS providers miss or the point is outside the metro area). Its street/postal address is joined by proximity from the Ryhti open_address dataset (so streetNameFi/streetNumber/postalCode/postalArea are populated), but it has no utility fields, and SYKE warns its data quality varies — treat it as enrichment, not authoritative.",
      "outOfArea:true → the point is outside the Helsinki metropolitan area; with the Ryhti fallback a building may still be found (found:true, national:true). found:false with outOfArea:true means even Ryhti had no match.",
      "found:false with outOfArea:false → no building within ~50 m of the point.",
      "For building data already stored on a worksite, `ib worksite get <id> --include-building` is cheaper.",
    ],
    seeAlso: ["ib worksite get", "ib opendata weather worksite", "ib sijainti list"],
    examples: [
      "ib opendata building --worksite 1234",
      "ib opendata building --sijainti 56",
      "ib opendata building --address 'Mannerheimintie 1, Helsinki'",
      "ib opendata building --address 'Hämeenkatu 1, Tampere'",
      "ib opendata building --lat 60.1699 --lng 24.9384 --city Helsinki",
      "ib opendata building --lat 61.4978 --lng 23.7610 --city Ryhti",
    ],
  },
  {
    command: "ib opendata parcel",
    description:
      "Look up cadastral parcel (kiinteistö / palsta) data for a property or point ANYWHERE in Finland, from MML's national open Kiinteistötietojen kyselypalvelu (OGC API Features). Complements `ib opendata building`: building answers 'what is built here', parcel answers 'which registered parcel is here / what does this kiinteistötunnus cover'. Resolve from EXACTLY ONE of: --kiinteistotunnus (dashed or 14-digit), --sijainti, --worksite (alias --tyomaa), --lat+--lng, or --address. Returns the parcel polygon(s), MML presentation-form id and a computed area (m²; the open product carries no registered-area attribute). NOTE: this is the registered cadastral unit, NOT the town-plan plot with building rights (rakennusoikeus). The propertyId returned by `ib opendata building` feeds straight into --kiinteistotunnus. Read-only; any authenticated user. Worksite resolution is tenant-scoped; sijainti is cross-tenant readable; cadastral data itself is public.",
    auth: "any",
    flags: [
      { name: "kiinteistotunnus", type: "string", description: "Property identifier, dashed (092-014-0202-0001) or 14-digit (09201402020001) — direct lookup, no geocode" },
      { name: "sijainti", type: "number", description: "Resolve coordinates from a sijainti id (cross-tenant readable)" },
      { name: "worksite", type: "number", description: "Resolve coordinates from a worksite (tyomaaId); tenant-scoped" },
      { name: "tyomaa", type: "number", description: "Alias for --worksite" },
      { name: "lat", type: "number", description: "Latitude (WGS84) — pair with --lng" },
      { name: "lng", type: "number", description: "Longitude (WGS84) — pair with --lat" },
      { name: "address", type: "string", description: "Street address to geocode (e.g. 'Sarkatie 7, Vantaa')" },
      { name: "with-buildings", type: "boolean", description: "Also count buildings on the parcel via national Ryhti (permit-based, best-effort); adds buildingCount + buildings to the parcel" },
    ],
    outputShape:
      "{ source:'kiinteistotunnus'|'sijainti'|'worksite'|'address'|'coords', input, coords:{lat,lng}|null, found:boolean, parcel:{ source:'MML', kiinteistotunnus, kiinteistotunnusFormatted, municipalityNumber, parcelCount, totalAreaM2, palstat:[{ palstaId, kiinteistotunnus, kiinteistotunnusFormatted, areaM2, representativePoint:{lat,lng}|null, geometry }], buildingCount?, buildings?:[{ nationalBuildingId, usagePurpose, completionYear, status }] (only with --with-buildings) } }",
    errors: [
      { origin: "client", exit: 4, meaning: "No source, multiple sources, both kiinteistotunnus and a point, invalid kiinteistotunnus, or invalid coords", remedy: "pass exactly one of --kiinteistotunnus / --sijainti / --worksite / --lat+--lng / --address" },
      apiErr(404, "Sijainti/worksite not found (or no coordinates), or address not geocodable", "verify the id/address; a worksite must be geocoded and in your tenant"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "parcelCount / number of polygons = number of PALSTAT (separate land pieces that make up one property), NOT the number of buildings on it. Pass --with-buildings to count buildings on the parcel (national Ryhti, deduped by pysyva_rakennustunnus); use `ib opendata building` for one building's full detail.",
      "--with-buildings adds parcel.buildingCount + parcel.buildings from the national Ryhti dataset (permit-based; SYKE warns coverage/quality varies, so treat the count as best-effort). It is a best-effort enrichment: a Ryhti failure leaves buildingCount:null + buildingsError and does not fail the parcel lookup.",
      "areaM2 is COMPUTED from the parcel polygon (projected to EPSG:3067 + shoelace); MML's open 'simple' product carries no authoritative registered-area attribute, so treat it as a close approximation.",
      "kiinteistotunnusFormatted is MML's presentation form with leading zeros dropped (e.g. '92-14-202-1'); kiinteistotunnus is the 14-digit database form used by the API.",
      "found:false → MML returned no parcel for the tunnus/point (e.g. outside Finland, or an unregistered point).",
    ],
    seeAlso: ["ib opendata building", "ib worksite get", "ib sijainti list"],
    examples: [
      "ib opendata parcel --kiinteistotunnus 092-014-0202-0001",
      "ib opendata parcel --kiinteistotunnus 92742200030051 --with-buildings",
      "ib opendata parcel --address 'Sarkatie 7, Vantaa'",
      "ib opendata parcel --worksite 1234",
      "ib opendata parcel --lat 60.272 --lng 24.8062",
    ],
  },
  {
    command: "ib opendata weather forecast",
    description:
      "Single-point FMI weather forecast for a lat/lng at a given time. Coordinates must be within Finland (lat 59.5–70.1, lng 19.0–31.6). Time must be within now..+240h. Requires the company weather module (asiakasPersonSettingTypeId 18); 403 if disabled.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "lat", type: "number", description: "Latitude (Finland 59.5–70.1)" },
      { name: "lng", type: "number", description: "Longitude (Finland 19.0–31.6)" },
      { name: "time", type: "string", description: "Forecast time, ISO 8601 or 'now'" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      { origin: "client", exit: 4, meaning: "--lat/--lng not a number", remedy: "pass decimal degrees, e.g. --lat 60.1699 --lng 24.9384" },
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on' (admin) or contact an admin"),
      apiErr(400, "Bad coords/time", "use Finland coords and a time within now..+240h"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather forecast --lat 60.1699 --lng 24.9384 --time now",
      "ib opendata weather forecast --lat 60.1699 --lng 24.9384 --time 2026-06-09T14:00:00Z",
    ],
  },
  {
    command: "ib opendata weather day",
    description:
      "Daily aggregate weather forecast (min/max/avg temperature, wind, precipitation) for a lat/lng on a calendar date. Accepts relative date aliases: today, tomorrow, yesterday. Coordinates must be within Finland. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "lat", type: "number", description: "Latitude (Finland 59.5–70.1)" },
      { name: "lng", type: "number", description: "Longitude (Finland 19.0–31.6)" },
      { name: "date", type: "string", description: "Date (YYYY-MM-DD, or today/tomorrow/yesterday)" },
    ],
    outputShape:
      "{ date, minTemp, maxTemp, avgTemp, windSpeed, precipitation, weatherSymbol, source, coordinates }",
    errors: [
      { origin: "client", exit: 4, meaning: "--lat/--lng not a number", remedy: "pass decimal degrees, e.g. --lat 60.17 --lng 24.94" },
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      apiErr(400, "Bad coords/date", "use Finland coords and a valid date"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather day --lat 60.17 --lng 24.94 --date today",
      "ib opendata weather day --lat 60.17 --lng 24.94 --date 2026-06-10",
    ],
  },
  {
    command: "ib opendata weather pumping",
    description:
      "Weather analysis over a concrete-pumping window: hourly conditions for the entire duration starting at --start. The backend can correlate with a keikka via --keikka for error reporting. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "lat", type: "number", description: "Latitude (Finland 59.5–70.1)" },
      { name: "lng", type: "number", description: "Longitude (Finland 19.0–31.6)" },
      { name: "start", type: "string", description: "Pumping start time (ISO 8601 or 'now')" },
      { name: "duration", type: "number", description: "Pumping duration in minutes" },
      { name: "keikka", type: "number", description: "Keikka id (optional, for backend error correlation only)" },
    ],
    outputShape:
      "{ hourly: [{ time, temperature, windSpeed, precipitation, weatherSymbol }], summary, coordinates }",
    errors: [
      { origin: "client", exit: 4, meaning: "--lat/--lng not a number, or --duration/--keikka not a positive integer", remedy: "pass decimal degrees and whole minutes, e.g. --lat 60.17 --lng 24.94 --duration 120" },
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      apiErr(400, "Bad coords/time/duration", "use Finland coords, valid ISO time, positive duration"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather pumping --lat 60.17 --lng 24.94 --start now --duration 120",
      "ib opendata weather pumping --lat 60.17 --lng 24.94 --start 2026-06-10T08:00:00Z --duration 90 --keikka 1234",
    ],
  },
  {
    command: "ib opendata weather worksite",
    description:
      "Forecast for a worksite identified by tyomaaId. The backend resolves the coordinates from the tyomaa record internally — no lat/lng needed. Use --force-refresh to bypass the cache. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId (coordinates resolved server-side)" }],
    flags: [
      { name: "force-refresh", type: "boolean", description: "Bypass the cache and refetch from FMI" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      apiErr(404, "Tyomaa not found or has no coordinates", "check tyomaaId; ensure the worksite has been geocoded"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather worksite 1234",
      "ib opendata weather worksite 1234 --force-refresh",
    ],
  },
  {
    command: "ib opendata weather sijainti",
    description:
      "Point forecast for a sijainti (depot/plant/location): resolves the location's coordinates (GET /api/geocode/sijainti/get/:id), then calls FMI. Sijainnit are cross-tenant readable. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId (coordinates resolved from the location)" }],
    flags: [
      { name: "time", type: "string", description: "Forecast time (ISO 8601 or 'now'; default now)" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      { http: 404, exit: 5, meaning: "Sijainti not found or has no coordinates", remedy: "check sijaintiId; ensure the location has a GPS pin (`ib sijainti list`)" },
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather sijainti 56",
      "ib opendata weather sijainti 56 --time 2026-06-30T08:00:00Z",
    ],
  },
  {
    command: "ib opendata weather keikka",
    description:
      "Forecast for a keikka: resolves the keikka's worksite (GET /api/cli/keikka/get/:id → worksite.tyomaaId) and returns the worksite forecast (POST /api/weather/tyomaa/:id). Tenant-scoped via the keikka. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    args: [{ name: "keikkaId", type: "number", description: "keikkaId (coordinates resolved from its worksite)" }],
    flags: [
      { name: "force-refresh", type: "boolean", description: "Bypass the cache and refetch from FMI" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      { http: 404, exit: 5, meaning: "Keikka not found or has no worksite", remedy: "check keikkaId; the keikka must have a worksite with coordinates" },
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib opendata weather worksite", "ib keikka get"],
    examples: [
      "ib opendata weather keikka 9001",
      "ib opendata weather keikka 9001 --force-refresh",
    ],
  },
  {
    command: "ib opendata weather address",
    description:
      "Point forecast for a street address: geocodes the address via Google Maps (POST /api/geocode/getLatLng), then calls FMI for the forecast. Requires the company weather module. Fails with exit 5 (not-found) if the address returns ZERO_RESULTS from Google.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "address", type: "string", description: "Street address (min 5 chars)" },
      { name: "time", type: "string", description: "Forecast time (ISO 8601 or 'now')" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      { http: 404, exit: 5, meaning: "Address not found (ZERO_RESULTS)", remedy: "try a more specific Finnish address" },
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather address --address 'Mannerheimintie 1, Helsinki' --time now",
      "ib opendata weather address --address 'Tampereen valtatie 5, Tampere' --time 2026-06-10T10:00:00Z",
    ],
  },
  {
    command: "ib opendata weather status",
    description:
      "Check whether the weather module is enabled for the active company. Does not require the weather module itself to be enabled (no circular dependency). Returns the enabled/disabled status and related settings.",
    auth: "any",
    flags: [],
    outputShape: "{ enabled: boolean, ... }",
    errors: [
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib opendata weather status"],
  },
  {
    command: "ib opendata weather toggle",
    description:
      "Enable or disable the weather module for the active company. Pass exactly one of --on or --off. Admin-scoped operation. Supports --dry-run, --idempotency-key, and --reason for audit trail.",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    flags: [
      { name: "on", type: "boolean", description: "Enable the module" },
      { name: "off", type: "boolean", description: "Disable the module" },
    ],
    outputShape: "{ success: boolean, enabled: boolean, ... }",
    errors: [
      { origin: "client", exit: 4, meaning: "Neither --on nor --off passed, or both passed", remedy: "pass exactly one of --on / --off" },
      apiErr(403, "Permission denied (admin required)", "requires admin role on the company"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather toggle --on --reason 'enabling for summer season'",
      "ib opendata weather toggle --off --dry-run",
    ],
  },
  {
    command: "ib opendata prh",
    description:
      "Look up a company in the Finnish business registry (PRH open data). Pass <ytunnus> for an exact business-ID lookup, or --search <name>. Read-only; any authenticated user. Re-homed from `ib customer prh` (still works as a hidden alias); customer create/update prefill from the same data via --from-prh.",
    auth: "any",
    args: [{ name: "ytunnus", type: "string", required: false, description: "business ID (XXXXXXXX-X)" }],
    flags: [
      { name: "search", type: "string", description: "Search by company name instead" },
      { name: "page", type: "number", default: "1", description: "Result page for --search" },
    ],
    outputShape:
      "by-id: { businessId, name, tradeNames, address:{street,postCode,city,full}, companyForm, status } | search: ListEnvelope<{ businessId, name, city }>",
    errors: [
      apiErr(404, "Business ID not found", "verify the Y-tunnus"),
      apiErr(400, "Invalid Y-tunnus format", "use XXXXXXXX-X"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib customer create", "ib opendata building"],
    examples: ["ib opendata prh 0145937-9", "ib opendata prh --search Betoni"],
  },
];
