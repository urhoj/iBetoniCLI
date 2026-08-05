/**
 * Pull {lat,lng} out of the /api/geocode/getLatLng response — the raw Google
 * Geocoding payload (`results[0].geometry.location`), with a top-level
 * {lat,lng} fallback. Returns null for ZERO_RESULTS / error / 0,0 shapes.
 *
 * NOT interchangeable with `runWeatherAddress`'s `extractLatLng`, which is
 * deliberately different (see `commands/weather/index.ts`).
 */
export function extractGeocodeLatLng(geo: unknown): { lat: number; lng: number } | null {
  const g = geo as Record<string, unknown> | null;
  if (!g || typeof g !== "object") return null;
  const loc =
    (g.results as Array<{ geometry?: { location?: { lat?: unknown; lng?: unknown } } }> | undefined)?.[0]
      ?.geometry?.location ?? { lat: g.lat, lng: g.lng };
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    return { lat, lng };
  }
  return null;
}
