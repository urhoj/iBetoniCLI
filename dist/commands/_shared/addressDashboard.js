import { CliError } from "../../api/errors.js";
/**
 * Shared orchestrator behind `ib worksite dashboard` / `ib sijainti dashboard`
 * (Address Information Dashboard, spec 2026-07-01). Fans out to the seven
 * granular Address Information Dashboard endpoints CLI-side (no BFF — mirrors
 * the FE's own `Promise.allSettled` panel model) and merges them into one
 * report, gated per-panel by whatever the caller's token allows (a 403 on any
 * one panel — e.g. no `hasWeather` module — degrades that panel to
 * `forbidden` instead of failing the whole command).
 */
const SECTION_NAMES = [
    "weather",
    "building",
    "parcel",
    "cameras",
    "sijainti",
    "deliveries",
    "vehicles",
];
/**
 * Spec §2 "AT / CLOSE" — CLOSE is a tunable constant, expected to be tuned;
 * shared search radius for the sijainti/ecofleet/cameras panels. Mirrors the
 * FE sibling's `DASHBOARD_CLOSE_RADIUS_M` (`useAddressDashboard.js`).
 */
const DASHBOARD_CLOSE_RADIUS_M = 2000;
/** Keys whose value is stripped anywhere in a section's `data` before it is returned. */
const STRIP_KEYS = new Set(["geometry", "rawData", "rawProperties", "rawGeometry"]);
/**
 * Recursively drop {@link STRIP_KEYS} from an arbitrary JSON-like value
 * (arrays and nested objects included) so heavy polygon/raw-provider blobs
 * never bloat the printed report. Returns a new structure; the input is not
 * mutated.
 */
export function deepStripHeavyFields(value) {
    if (Array.isArray(value)) {
        return value.map((v) => deepStripHeavyFields(v));
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, v] of Object.entries(value)) {
            if (STRIP_KEYS.has(key))
                continue;
            out[key] = deepStripHeavyFields(v);
        }
        return out;
    }
    return value;
}
/**
 * A fulfilled section's value counts as `empty` (rather than `ok`) when it
 * matches one of the well-known "nothing found" shapes emitted by the seven
 * panels: an empty `items`/`days` array, `found:false` (building/parcel),
 * `tyomaa:null` (deliveries — no worksite resolved), or `enabled:false`
 * (a module-gated panel that resolved but is off, e.g. ecofleet).
 */
function isEmptySectionValue(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    if (Array.isArray(v.items) && v.items.length === 0)
        return true;
    if (Array.isArray(v.days) && v.days.length === 0)
        return true;
    if (v.found === false)
        return true;
    if (v.tyomaa === null)
        return true;
    if (v.enabled === false)
        return true;
    return false;
}
/** True for a rejection that carries an HTTP 403 / mapped exit code 3 (permission-denied). */
function isForbiddenReason(reason) {
    if (!reason || typeof reason !== "object")
        return false;
    const r = reason;
    return r.statusCode === 403 || r.exitCode === 3;
}
/**
 * Extract a short message from a settled-promise rejection reason. Handles a
 * real `Error`/`CliError` (the normal production shape) as well as a bare
 * `{ message }` object (a plausible test/mock shape) without collapsing to
 * `"[object Object]"`.
 */
function reasonMessage(reason) {
    if (reason instanceof Error)
        return reason.message;
    if (reason &&
        typeof reason === "object" &&
        typeof reason.message === "string") {
        return reason.message;
    }
    return String(reason);
}
/**
 * Map a settled-results bag (one entry per dashboard section) to the report
 * shape: `fulfilled` → `ok` (or `empty`, see {@link isEmptySectionValue}),
 * `rejected` → `error` (or `forbidden` for a 403-shaped reason). Every
 * fulfilled section's `data` is deep-stripped of heavy geometry/raw-provider
 * blobs (see {@link deepStripHeavyFields}) so the report stays light.
 *
 * Generic over the caller's section keys — `runAddressDashboard` calls it
 * with all seven; tests may call it with any subset.
 */
export function assembleReport(sections) {
    const report = {};
    for (const key of Object.keys(sections)) {
        const settled = sections[key];
        if (settled.status === "fulfilled") {
            const data = deepStripHeavyFields(settled.value);
            report[key] = { status: isEmptySectionValue(data) ? "empty" : "ok", data };
        }
        else {
            report[key] = {
                status: isForbiddenReason(settled.reason) ? "forbidden" : "error",
                error: reasonMessage(settled.reason),
            };
        }
    }
    return report;
}
/**
 * Pull `{lat,lng}` out of `/api/geocode/getLatLng`'s raw Google payload
 * (`results[0].geometry.location`), with a normalized top-level `{lat,lng}`
 * fallback (mirrors `runWeatherAddress`'s `extractLatLng`). Returns null for
 * ZERO_RESULTS / error / 0,0 shapes.
 */
function extractGeocodedLatLng(geo) {
    const g = geo;
    if (!g || typeof g !== "object")
        return null;
    const results = g.results;
    const location = results?.[0]?.geometry?.location;
    const lat = Number(location?.lat ?? g.lat);
    const lng = Number(location?.lng ?? g.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        return { lat, lng };
    }
    return null;
}
/**
 * Phase 1: resolve the caller's point (`address` | `tyomaaId` | `sijaintiId`)
 * to `{lat,lng}`. The `source` query fragment returned alongside it is used
 * ONLY by this function's own `tyomaaId`/`sijaintiId` parcel resolve below —
 * phase 2's building/parcel fan-out uses the resolved `{lat,lng}` instead
 * (see {@link runAddressDashboard}), avoiding a redundant server-side
 * re-geocode/re-resolve of the same source.
 *
 * - `address` — geocode via `POST /api/geocode/getLatLng`.
 * - `tyomaaId` / `sijaintiId` — coordinates aren't carried by the caller, so
 *   they are resolved from the parcel lookup's `coords` field — fetched
 *   once here and reused as the `parcel` section in phase 2 (no double fetch).
 *
 * Throws a `CliError` (exit 4 for a missing/ambiguous input, exit 5 for an
 * unresolvable point) — the caller turns that into a report-shaped result
 * instead of letting the whole command fail.
 */
async function resolvePoint(client, input) {
    if (input.address !== undefined) {
        const source = `address=${encodeURIComponent(input.address)}`;
        // Read-over-POST: geocoding an address mutates nothing. `{ read: true }`
        // exempts it from the `--read-only` write-lock AND suppresses the
        // "[ib] write → asiakasId …" acting-as banner (a dashboard is read-only).
        const geo = await client.post("/api/geocode/getLatLng", { osoite: input.address }, { read: true });
        const coords = extractGeocodedLatLng(geo);
        if (!coords) {
            const status = geo?.status ?? "unknown";
            throw new CliError(`could not geocode address (status: ${status})`, 404, geo, 5);
        }
        return { lat: coords.lat, lng: coords.lng, source };
    }
    const source = input.tyomaaId !== undefined
        ? `worksite=${input.tyomaaId}`
        : input.sijaintiId !== undefined
            ? `sijainti=${input.sijaintiId}`
            : null;
    if (source === null) {
        throw new CliError("provide exactly one of tyomaaId, sijaintiId, or address", 0, null, 4);
    }
    const parcel = await client.get(`/api/cli/opendata/parcel/lookup?${source}&withBuildings=1`);
    const coords = parcel?.coords;
    const lat = Number(coords?.lat);
    const lng = Number(coords?.lng);
    if (!coords || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new CliError("could not resolve coordinates for the given point", 404, parcel, 5);
    }
    return { lat, lng, source, parcel };
}
/**
 * Build a `Record<SectionName, PromiseSettledResult<unknown>>` where every
 * section is rejected with the same `reason` — used when phase 1 (point
 * resolution) fails, so the command still prints a full report instead of
 * throwing.
 */
function allSectionsRejected(reason) {
    const sections = {};
    for (const name of SECTION_NAMES) {
        sections[name] = { status: "rejected", reason };
    }
    return sections;
}
/**
 * Orchestrate the Address Information Dashboard (spec 2026-07-01 §8):
 * resolve `input` to a point, then fan out to the seven panel endpoints with
 * `Promise.allSettled` and merge them via {@link assembleReport}.
 *
 * `input` carries exactly one of `tyomaaId` / `sijaintiId` / `address` — the
 * caller (`ib worksite dashboard` / `ib sijainti dashboard`) resolves that
 * exclusivity from its own positional/flag; this function itself just prefers
 * `address`, then `tyomaaId`, then `sijaintiId` if more than one is somehow
 * present.
 *
 * If the point cannot be resolved (bad address, worksite/sijainti with no
 * coordinates), every section reports `status:"error"` with the same message
 * instead of the whole command throwing — a partial dashboard for an
 * unresolvable point is still useful (e.g. distinguishing "no coordinates"
 * from "weather module disabled").
 */
export async function runAddressDashboard(client, input) {
    let resolved;
    try {
        resolved = await resolvePoint(client, input);
    }
    catch (err) {
        return {
            point: null,
            address: input.address ?? null,
            ...assembleReport(allSectionsRejected(err)),
        };
    }
    const { lat, lng, parcel } = resolved;
    const deliveriesPath = input.tyomaaId !== undefined
        ? `/api/tyomaa/delivery-summary?tyomaaId=${input.tyomaaId}`
        : `/api/tyomaa/delivery-summary?lat=${lat}&lng=${lng}`;
    // building/parcel reuse the already-resolved {lat,lng} rather than the raw
    // `source` token — both `/building/lookup` and `/parcel/lookup` would
    // otherwise re-resolve it server-side (re-geocode for `address=`, a second
    // DB lookup for `worksite=`/`sijainti=`). The tyomaaId/sijaintiId forms
    // still reuse the single `parcel` result fetched in resolvePoint instead of
    // issuing a second parcel/lookup call.
    const [weather, building, parcelSettled, cameras, sijainti, deliveries, vehicles] = await Promise.allSettled([
        client.get(`/api/weather/forecast-days/${lat}/${lng}?days=10`),
        client.get(`/api/cli/opendata/building/lookup?lat=${lat}&lng=${lng}`),
        parcel !== undefined
            ? parcel
            : client.get(`/api/cli/opendata/parcel/lookup?lat=${lat}&lng=${lng}&withBuildings=1`),
        client.get(`/api/cameras/point/${lat}/${lng}?radiusKm=${DASHBOARD_CLOSE_RADIUS_M / 1000}`),
        client.get(`/api/sijainti/near?lat=${lat}&lng=${lng}&radius=${DASHBOARD_CLOSE_RADIUS_M}`),
        client.get(deliveriesPath),
        client.get(`/api/ecofleet/near?lat=${lat}&lng=${lng}&radius=${DASHBOARD_CLOSE_RADIUS_M}`),
    ]);
    return {
        point: { lat, lng },
        address: input.address ?? null,
        ...assembleReport({
            weather,
            building,
            parcel: parcelSettled,
            cameras,
            sijainti,
            deliveries,
            vehicles,
        }),
    };
}
//# sourceMappingURL=addressDashboard.js.map