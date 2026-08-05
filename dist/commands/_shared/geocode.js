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
//# sourceMappingURL=geocode.js.map