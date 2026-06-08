import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runWeatherForecast,
  runWeatherDay,
  runWeatherPumping,
  runWeatherWorksite,
  runWeatherAddress,
  runWeatherStatus,
  runWeatherToggle,
} from "../../src/commands/weather/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

beforeEach(() => {
  (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
});

// ─── forecast ────────────────────────────────────────────────────────────────

describe("ib weather forecast", () => {
  test("GETs the forecast endpoint with encoded path params", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      temperature: 8.7,
      windSpeed: 7.07,
      source: "HARMONIE",
    });
    const out = await runWeatherForecast(mockClient, {
      lat: 60.1699,
      lng: 24.9384,
      time: "2026-06-09T14:00:00.000Z",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/weather/forecast/60.1699/24.9384/2026-06-09T14%3A00%3A00.000Z"
    );
    expect(out).toMatchObject({ temperature: 8.7, source: "HARMONIE" });
  });

  test("resolves 'now' alias to an ISO timestamp", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ temperature: 5 });
    await runWeatherForecast(mockClient, { lat: 60.17, lng: 24.94, time: "now" });
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(path).not.toContain("now");
    expect(path).toMatch(/\/api\/weather\/forecast\/60\.17\/24\.94\/.+Z/);
  });
});

// ─── day ─────────────────────────────────────────────────────────────────────

describe("ib weather day", () => {
  test("GETs the day endpoint and resolves date aliases", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ minTemp: 5 });
    await runWeatherDay(mockClient, { lat: 60.17, lng: 24.94, date: "today" });
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(path).toMatch(/^\/api\/weather\/day\/60\.17\/24\.94\/\d{4}-\d{2}-\d{2}$/);
  });

  test("passes a literal ISO date through unchanged", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ minTemp: 3 });
    await runWeatherDay(mockClient, { lat: 60.17, lng: 24.94, date: "2026-06-10" });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/weather/day/60.17/24.94/2026-06-10"
    );
  });
});

// ─── pumping ──────────────────────────────────────────────────────────────────

describe("ib weather pumping", () => {
  test("builds the period path with duration minutes", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ hourly: [] });
    await runWeatherPumping(mockClient, {
      lat: 60.17,
      lng: 24.94,
      start: "2026-06-09T08:00:00.000Z",
      duration: 135,
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/weather/pumping-period/60.17/24.94/2026-06-09T08%3A00%3A00.000Z/135"
    );
  });

  test("appends keikkaId as query param when provided", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ hourly: [] });
    await runWeatherPumping(mockClient, {
      lat: 60.17,
      lng: 24.94,
      start: "2026-06-09T08:00:00.000Z",
      duration: 60,
      keikka: 42,
    });
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(path).toContain("?keikkaId=42");
  });

  test("resolves 'now' alias for start", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ hourly: [] });
    await runWeatherPumping(mockClient, {
      lat: 60.17,
      lng: 24.94,
      start: "now",
      duration: 90,
    });
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(path).not.toContain("now");
    expect(path).toMatch(/\/api\/weather\/pumping-period\/60\.17\/24\.94\/.+\/90/);
  });
});

// ─── worksite ─────────────────────────────────────────────────────────────────

describe("ib weather worksite", () => {
  test("POSTs to the tyomaa endpoint with forceRefresh: true", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tyomaaId: 123 });
    await runWeatherWorksite(mockClient, 123, true);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/weather/tyomaa/123",
      { forceRefresh: true }
    );
  });

  test("POSTs to the tyomaa endpoint with forceRefresh: false", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tyomaaId: 456 });
    await runWeatherWorksite(mockClient, 456, false);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/weather/tyomaa/456",
      { forceRefresh: false }
    );
  });
});

// ─── address ──────────────────────────────────────────────────────────────────

describe("ib weather address", () => {
  test("geocodes via getLatLng then forecasts (Google results[] shape)", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "OK",
      results: [{ geometry: { location: { lat: 60.17, lng: 24.94 } } }],
    });
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ temperature: 5 });
    const out = await runWeatherAddress(mockClient, {
      address: "Mannerheimintie 1, Helsinki",
      time: "2026-06-09T12:00:00.000Z",
    });
    expect(mockClient.post).toHaveBeenCalledWith("/api/geocode/getLatLng", {
      osoite: "Mannerheimintie 1, Helsinki",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/weather/forecast/60.17/24.94/2026-06-09T12%3A00%3A00.000Z"
    );
    expect(out).toMatchObject({ temperature: 5 });
  });

  test("geocodes via getLatLng then forecasts (normalized {lat,lng} shape)", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      lat: 60.17,
      lng: 24.94,
    });
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ temperature: 5 });
    const out = await runWeatherAddress(mockClient, {
      address: "Mannerheimintie 1, Helsinki",
      time: "2026-06-09T12:00:00.000Z",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/weather/forecast/60.17/24.94/2026-06-09T12%3A00%3A00.000Z"
    );
    expect(out).toMatchObject({ temperature: 5 });
  });

  test("throws CliError(exit 5) on ZERO_RESULTS", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "ZERO_RESULTS",
    });
    await expect(
      runWeatherAddress(mockClient, { address: "nowhere place xyz", time: "now" })
    ).rejects.toMatchObject({ exitCode: 5 });
  });

  test("throws CliError(exit 5) on missing coordinates", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "REQUEST_DENIED",
    });
    await expect(
      runWeatherAddress(mockClient, { address: "some address here", time: "now" })
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});

// ─── status ───────────────────────────────────────────────────────────────────

describe("ib weather status", () => {
  test("GETs module status", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ enabled: true });
    expect(await runWeatherStatus(mockClient)).toMatchObject({ enabled: true });
    expect(mockClient.get).toHaveBeenCalledWith("/api/weather/module/status");
  });
});

// ─── toggle ───────────────────────────────────────────────────────────────────

describe("ib weather toggle", () => {
  test("POSTs enabled: true with write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await runWeatherToggle(mockClient, true, { reason: "enable" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/weather/module/toggle",
      { enabled: true },
      { headers: { "X-Action-Reason": "enable" } }
    );
  });

  test("POSTs enabled: false with dry-run header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await runWeatherToggle(mockClient, false, { dryRun: true });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/weather/module/toggle",
      { enabled: false },
      { headers: { "X-Dry-Run": "1" } }
    );
  });
});
