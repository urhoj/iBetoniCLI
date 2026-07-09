import { describe, test, expect, vi, beforeEach } from "vitest";
import { assembleReport, runAddressDashboard } from "../addressDashboard.js";
import { CliError } from "../../../api/errors.js";
import type { ApiClient } from "../../../api/client.js";

// ─── assembleReport ─────────────────────────────────────────────────────────

describe("assembleReport", () => {
  test("a fulfilled non-empty value maps to ok", () => {
    const r = assembleReport({
      weather: { status: "fulfilled", value: { days: [{ date: "2026-07-01" }] } },
    });
    expect(r.weather).toEqual({ status: "ok", data: { days: [{ date: "2026-07-01" }] } });
  });

  test("a fulfilled 'nothing found' value maps to empty (items/days/found/tyomaa/enabled)", () => {
    const r = assembleReport({
      sijainti: { status: "fulfilled", value: { items: [] } },
      weather: { status: "fulfilled", value: { days: [] } },
      building: { status: "fulfilled", value: { found: false } },
      deliveries: { status: "fulfilled", value: { tyomaa: null } },
      vehicles: { status: "fulfilled", value: { enabled: false, items: [] } },
    });
    expect(r.sijainti.status).toBe("empty");
    expect(r.weather.status).toBe("empty");
    expect(r.building.status).toBe("empty");
    expect(r.deliveries.status).toBe("empty");
    expect(r.vehicles.status).toBe("empty");
  });

  test("a rejected Error maps to error with its message", () => {
    const r = assembleReport({
      building: { status: "rejected", reason: new Error("boom") },
    });
    expect(r.building).toEqual({ status: "error", error: "boom" });
  });

  test("a rejected plain {message} reason maps to error without collapsing to [object Object]", () => {
    const r = assembleReport({
      building: { status: "rejected", reason: { message: "x" } },
    });
    expect(r.building).toEqual({ status: "error", error: "x" });
  });

  test("a 403-shaped rejection maps to forbidden", () => {
    const r = assembleReport({
      weather: {
        status: "rejected",
        reason: { statusCode: 403, message: "weather module disabled" },
      },
    });
    expect(r.weather.status).toBe("forbidden");
  });

  test("an exitCode:3 rejection (client-side CliError shape) also maps to forbidden", () => {
    const r = assembleReport({
      vehicles: { status: "rejected", reason: { exitCode: 3, message: "nope" } },
    });
    expect(r.vehicles.status).toBe("forbidden");
  });

  test("strips geometry/rawData/rawProperties/rawGeometry anywhere in nested data", () => {
    const r = assembleReport({
      parcel: {
        status: "fulfilled",
        value: {
          coords: { lat: 60.17, lng: 24.94 },
          parcel: {
            totalAreaM2: 5,
            palstat: [{ areaM2: 5, geometry: { big: 1 } }],
            rawData: { huge: true },
          },
          rawProperties: { x: 1 },
          nested: { rawGeometry: [1, 2, 3] },
        },
      },
    });
    const data = r.parcel.data as {
      coords: { lat: number };
      parcel: { palstat: Array<{ geometry?: unknown }>; rawData?: unknown };
      rawProperties?: unknown;
      nested: { rawGeometry?: unknown };
    };
    expect(data.parcel.palstat[0].geometry).toBeUndefined();
    expect(data.parcel.rawData).toBeUndefined();
    expect(data.rawProperties).toBeUndefined();
    expect(data.nested.rawGeometry).toBeUndefined();
    // non-stripped fields survive untouched
    expect(data.coords.lat).toBe(60.17);
    expect(data.parcel.totalAreaM2).toBe(5);
  });
});

// ─── runAddressDashboard ─────────────────────────────────────────────────────

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const get = () => mockClient.get as ReturnType<typeof vi.fn>;
const post = () => mockClient.post as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get().mockReset();
  post().mockReset();
});

/** Wire a canned "everything found" response for all 7 panel GETs. */
function setupHappyPath(coords: { lat: number; lng: number }): void {
  get().mockImplementation(async (path: string) => {
    if (path.startsWith("/api/weather/forecast-days/")) {
      return { coords, days: [{ date: "2026-07-01", minTemp: 10 }] };
    }
    if (path.startsWith("/api/cli/opendata/building/lookup")) {
      return { found: true, building: { id: 1 } };
    }
    if (path.startsWith("/api/cli/opendata/parcel/lookup")) {
      return { found: true, coords, parcel: { totalAreaM2: 500 } };
    }
    if (path.startsWith("/api/cameras/point/")) {
      return { cameras: [{ id: 1 }], cameraCount: 1 };
    }
    if (path.startsWith("/api/sijainti/near")) {
      return { items: [{ sijaintiId: 5 }] };
    }
    if (path.startsWith("/api/tyomaa/delivery-summary")) {
      return { tyomaa: { tyomaaId: 9 }, byAsiakas: [], keikat: [] };
    }
    if (path.startsWith("/api/ecofleet/near")) {
      return { enabled: true, items: [] };
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

describe("runAddressDashboard — address input", () => {
  test("geocodes the address, then fans out all 7 endpoints from the geocoded point", async () => {
    const coords = { lat: 60.17, lng: 24.94 };
    setupHappyPath(coords);
    post().mockResolvedValueOnce({
      status: "OK",
      results: [{ geometry: { location: coords } }],
    });

    const report = await runAddressDashboard(mockClient, {
      address: "Mannerheimintie 1, Helsinki",
    });

    // read-over-POST: flagged { read: true } so it skips the --read-only
    // write-lock and the "[ib] write · acting as …" acting-as banner.
    expect(post()).toHaveBeenCalledWith(
      "/api/geocode/getLatLng",
      { osoite: "Mannerheimintie 1, Helsinki" },
      { read: true }
    );
    // exactly one geocode for the whole dashboard — building/parcel reuse the
    // resolved coords instead of re-geocoding the address server-side.
    expect(post()).toHaveBeenCalledTimes(1);
    expect(report.point).toEqual(coords);
    expect(report.address).toBe("Mannerheimintie 1, Helsinki");

    const paths = get().mock.calls.map((c: unknown[]) => c[0] as string);
    expect(paths).toContain(`/api/weather/forecast-days/${coords.lat}/${coords.lng}?days=10`);
    expect(paths).toContain(`/api/cli/opendata/building/lookup?lat=${coords.lat}&lng=${coords.lng}`);
    expect(paths).toContain(
      `/api/cli/opendata/parcel/lookup?lat=${coords.lat}&lng=${coords.lng}&withBuildings=1`
    );
    expect(paths).toContain(`/api/cameras/point/${coords.lat}/${coords.lng}?radiusKm=2`);
    expect(paths).toContain(`/api/sijainti/near?lat=${coords.lat}&lng=${coords.lng}&radius=2000`);
    // address form has no tyomaaId — deliveries falls back to lat/lng
    expect(paths).toContain(`/api/tyomaa/delivery-summary?lat=${coords.lat}&lng=${coords.lng}`);
    expect(paths).toContain(`/api/ecofleet/near?lat=${coords.lat}&lng=${coords.lng}&radius=2000`);

    expect(report.weather.status).toBe("ok");
    expect(report.building.status).toBe("ok");
    expect(report.parcel.status).toBe("ok");
    expect(report.deliveries.status).toBe("ok");
  });
});

describe("runAddressDashboard — tyomaaId input", () => {
  test("resolves coords via one parcel call, reuses it as the parcel section, deliveries uses tyomaaId", async () => {
    const coords = { lat: 61.5, lng: 23.7 };
    setupHappyPath(coords);

    const report = await runAddressDashboard(mockClient, { tyomaaId: 123 });

    expect(post()).not.toHaveBeenCalled();
    const paths = get().mock.calls.map((c: unknown[]) => c[0] as string);
    const parcelCalls = paths.filter((p) => p.startsWith("/api/cli/opendata/parcel/lookup"));
    expect(parcelCalls).toHaveLength(1); // fetched once, reused as the parcel section
    expect(parcelCalls[0]).toBe("/api/cli/opendata/parcel/lookup?worksite=123&withBuildings=1");
    // building/lookup uses the resolved coords, not the worksite= source token
    // (no redundant DB re-resolve server-side).
    expect(paths).toContain(`/api/cli/opendata/building/lookup?lat=${coords.lat}&lng=${coords.lng}`);
    expect(paths).toContain("/api/tyomaa/delivery-summary?tyomaaId=123");
    expect(paths).toContain(`/api/weather/forecast-days/${coords.lat}/${coords.lng}?days=10`);
    expect(report.point).toEqual(coords);
    expect(report.parcel.status).toBe("ok");
  });
});

describe("runAddressDashboard — sijaintiId input", () => {
  test("resolves coords via parcel lookup with sijainti= source; deliveries falls back to lat/lng", async () => {
    const coords = { lat: 62.0, lng: 25.5 };
    setupHappyPath(coords);

    const report = await runAddressDashboard(mockClient, { sijaintiId: 56 });

    const paths = get().mock.calls.map((c: unknown[]) => c[0] as string);
    expect(paths.filter((p) => p.startsWith("/api/cli/opendata/parcel/lookup"))).toHaveLength(1);
    expect(paths).toContain("/api/cli/opendata/parcel/lookup?sijainti=56&withBuildings=1");
    // building/lookup uses the resolved coords, not the sijainti= source token
    // (no redundant DB re-resolve server-side).
    expect(paths).toContain(`/api/cli/opendata/building/lookup?lat=${coords.lat}&lng=${coords.lng}`);
    // no tyomaaId on this input form — deliveries falls back to lat/lng
    expect(paths).toContain(`/api/tyomaa/delivery-summary?lat=${coords.lat}&lng=${coords.lng}`);
    expect(report.point).toEqual(coords);
  });
});

describe("runAddressDashboard — unresolvable point", () => {
  test("returns an error report instead of throwing when coordinates can't be resolved", async () => {
    get().mockResolvedValueOnce({ found: false, coords: null });

    const report = await runAddressDashboard(mockClient, { tyomaaId: 999 });

    expect(report.point).toBeNull();
    for (const section of [
      "weather",
      "building",
      "parcel",
      "cameras",
      "sijainti",
      "deliveries",
      "vehicles",
    ] as const) {
      expect(report[section].status).toBe("error");
    }
  });
});

describe("runAddressDashboard — per-panel 403", () => {
  test("a 403 from one panel maps only that section to forbidden; the rest still resolve", async () => {
    const coords = { lat: 60.17, lng: 24.94 };
    post().mockResolvedValueOnce({ status: "OK", results: [{ geometry: { location: coords } }] });
    get().mockImplementation(async (path: string) => {
      if (path.startsWith("/api/weather/forecast-days/")) {
        throw new CliError("weather module not enabled", 403, { error: "forbidden" }, 3);
      }
      if (path.startsWith("/api/cli/opendata/building/lookup")) return { found: true };
      if (path.startsWith("/api/cli/opendata/parcel/lookup")) return { found: true, parcel: {} };
      if (path.startsWith("/api/cameras/point/")) return { cameras: [] };
      if (path.startsWith("/api/sijainti/near")) return { items: [] };
      if (path.startsWith("/api/tyomaa/delivery-summary")) return { tyomaa: null };
      if (path.startsWith("/api/ecofleet/near")) return { enabled: true, items: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    const report = await runAddressDashboard(mockClient, { address: "Somewhere 1" });

    expect(report.weather.status).toBe("forbidden");
    expect(report.building.status).toBe("ok");
    expect(report.deliveries.status).toBe("empty"); // tyomaa: null
  });
});
