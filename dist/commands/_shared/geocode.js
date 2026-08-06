/**
 * Pull {lat,lng} out of the /api/geocode/getLatLng response — the raw Google
 * Geocoding payload (`results[0].geometry.location`), with a top-level
 * {lat,lng} fallback. Returns null for ZERO_RESULTS / error / 0,0 shapes.
 *
 * NOT interchangeable with `runWeatherAddress`'s `extractLatLng`, which is
 * deliberately different (see `commands/weather/index.ts`).
 */
export function extractGeocodeLatLng(geo) {
    const g = geo;
    if (!g || typeof g !== "object")
        return null;
    const loc = g.results?.[0]
        ?.geometry?.location ?? { lat: g.lat, lng: g.lng };
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        return { lat, lng };
    }
    return null;
}
/**
 * Project the raw Google Geocoding payload onto the FLAT shape that
 * `/api/pumppuRequests/checkAddress` (→ `ib jerry check-address`) returns, so
 * the CLI's two geocoding entry points agree on field names (feedback #317 — a
 * parser written against one silently got undefined,undefined from the other).
 *
 * `geocoded:false` (not a throw) on no match, mirroring check-address: the
 * caller distinguishes "no such address" from a failure by the flag, not by an
 * exit code. Callers wanting the raw payload keep reading `results[]`.
 */
export function flattenGeocodeResult(geo) {
    const coords = extractGeocodeLatLng(geo);
    const first = geo?.results?.[0];
    const str = (v) => (typeof v === "string" && v ? v : null);
    return {
        geocoded: coords !== null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        placeId: str(first?.place_id),
        formattedAddress: str(first?.formatted_address),
    };
}
//# sourceMappingURL=geocode.js.map