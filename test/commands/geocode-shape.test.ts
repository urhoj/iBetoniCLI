import { describe, test, expect } from "vitest";
import {
  extractGeocodeLatLng,
  flattenGeocodeResult,
} from "../../src/commands/_shared/geocode.js";

/**
 * feedback #317 — `ib sijainti geocode` and `ib jerry check-address` geocode the
 * same address and returned incompatible shapes, so a parser written against one
 * silently produced undefined,undefined from the other. flattenGeocodeResult is
 * the projection that makes them agree.
 */
describe("flattenGeocodeResult", () => {
  const GOOGLE_OK = {
    status: "OK",
    results: [
      {
        formatted_address: "Heisikatu 3, 15300 Lahti, Finland",
        place_id: "ChIJw6lz7RvWkUYRsdBiLM0fHcs",
        geometry: { location: { lat: 60.9974026, lng: 25.7688606 } },
      },
    ],
  };

  test("projects the raw Google payload onto the check-address field names", () => {
    expect(flattenGeocodeResult(GOOGLE_OK)).toEqual({
      geocoded: true,
      lat: 60.9974026,
      lng: 25.7688606,
      placeId: "ChIJw6lz7RvWkUYRsdBiLM0fHcs",
      formattedAddress: "Heisikatu 3, 15300 Lahti, Finland",
    });
  });

  test("ZERO_RESULTS → geocoded:false with every field null, never a throw", () => {
    expect(flattenGeocodeResult({ status: "ZERO_RESULTS", results: [] })).toEqual({
      geocoded: false,
      lat: null,
      lng: null,
      placeId: null,
      formattedAddress: null,
    });
  });

  test("top-level {lat,lng} shape geocodes without results[] metadata", () => {
    expect(flattenGeocodeResult({ lat: 60.17, lng: 24.94 })).toEqual({
      geocoded: true,
      lat: 60.17,
      lng: 24.94,
      placeId: null,
      formattedAddress: null,
    });
  });

  test("0,0 is treated as no fix (same rule as extractGeocodeLatLng)", () => {
    expect(flattenGeocodeResult({ lat: 0, lng: 0 }).geocoded).toBe(false);
    expect(extractGeocodeLatLng({ lat: 0, lng: 0 })).toBeNull();
  });

  test("null / non-object input degrades to geocoded:false", () => {
    expect(flattenGeocodeResult(null).geocoded).toBe(false);
    expect(flattenGeocodeResult("nope").geocoded).toBe(false);
  });

  test("empty-string place_id / formatted_address normalise to null", () => {
    const out = flattenGeocodeResult({
      results: [{ place_id: "", formatted_address: "", geometry: { location: { lat: 1, lng: 2 } } }],
    });
    expect(out).toMatchObject({ geocoded: true, placeId: null, formattedAddress: null });
  });
});
