import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiCreate,
  runSijaintiUpdate,
  runSijaintiDelete,
  runSijaintiUndelete,
  runSijaintiSetJerry,
  runSijaintiSaveLatLng,
  persistSijaintiCoords,
  buildSijaintiBody,
  applySijaintiCreateDefaults,
  extractGeocodeLatLng,
} from "../../src/commands/sijainti/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib sijainti create/update", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runSijaintiCreate forwards body + all three write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 4242,
    });
    const body = {
      sijaintiNimi: "Helsinki HQ",
      sijaintiOsoite1: "Mannerheimintie 1",
      lat: 60.17,
      lng: 24.94,
    };
    const result = await runSijaintiCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-helsinki-hq",
      reason: "office relocation",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/geocode/sijainti/add",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "create-helsinki-hq",
          "X-Action-Reason": "office relocation",
        },
      }
    );
    expect((result as { sijaintiId: number }).sijaintiId).toBe(4242);
  });

  test("runSijaintiUpdate posts to /api/geocode/updateSijainti with sijaintiId IN body (not URL) + flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    const body = { sijaintiId: 4242, sijaintiNimi: "Helsinki HQ — Tower B" };
    await runSijaintiUpdate(mockClient, body, {
      reason: "tower split",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/geocode/updateSijainti",
      body,
      { headers: { "X-Action-Reason": "tower split" } }
    );
  });
});

describe("sijainti coordinate persistence (updateLatLng)", () => {
  const mPost = () => mockClient.post as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mPost().mockReset();
  });

  test("runSijaintiSaveLatLng: POST /api/geocode/updateLatLng/:id with {lat,lng} + flag headers (no placeId)", async () => {
    mPost().mockResolvedValueOnce({ success: true });
    await runSijaintiSaveLatLng(mockClient, 4242, 60.17, 24.94, { reason: "manual coords" });
    expect(mPost()).toHaveBeenCalledWith(
      "/api/geocode/updateLatLng/4242",
      { lat: 60.17, lng: 24.94 },
      { headers: { "X-Action-Reason": "manual coords" } }
    );
  });

  test("persistSijaintiCoords: persists coords then echoes { lat, lng, coordsPersisted:true }", async () => {
    mPost().mockResolvedValueOnce({ success: true });
    const out = await persistSijaintiCoords(
      mockClient,
      { sijaintiId: 4242, success: true },
      4242,
      { lat: 60.17, lng: 24.94 },
      {}
    );
    expect(mPost()).toHaveBeenCalledWith(
      "/api/geocode/updateLatLng/4242",
      { lat: 60.17, lng: 24.94 },
      { headers: {} }
    );
    expect(out).toEqual({ sijaintiId: 4242, success: true, lat: 60.17, lng: 24.94, coordsPersisted: true });
  });

  test("persistSijaintiCoords: no coords → returns result untouched, no write", async () => {
    const result = { sijaintiId: 7, success: true };
    const out = await persistSijaintiCoords(mockClient, result, 7, {}, {});
    expect(out).toBe(result);
    expect(mPost()).not.toHaveBeenCalled();
  });

  test("persistSijaintiCoords: dry-run echoes coords but never writes (coordsPersisted:false)", async () => {
    const out = await persistSijaintiCoords(
      mockClient,
      { dryRun: true, wouldCreate: {} },
      undefined,
      { lat: 60.17, lng: 24.94 },
      { dryRun: true }
    );
    expect(mPost()).not.toHaveBeenCalled();
    expect(out).toMatchObject({ lat: 60.17, lng: 24.94, coordsPersisted: false });
  });

  test("persistSijaintiCoords: coerces string coords; partial/invalid coords are ignored", async () => {
    mPost().mockResolvedValueOnce({ success: true });
    const out = await persistSijaintiCoords(
      mockClient,
      { sijaintiId: 9 },
      9,
      { lat: "60.17", lng: "24.94" },
      {}
    );
    expect(out).toMatchObject({ lat: 60.17, lng: 24.94, coordsPersisted: true });

    const partial = { sijaintiId: 9 };
    const out2 = await persistSijaintiCoords(mockClient, partial, 9, { lat: 60.17 }, {});
    expect(out2).toBe(partial);
    expect(mPost()).toHaveBeenCalledTimes(1); // only the first (full) call wrote
  });
});

describe("buildSijaintiBody (typed-flag merge)", () => {
  test("maps typed flags to backend field names", () => {
    expect(
      buildSijaintiBody(
        {},
        { name: "Depot A", address: "Teollisuuskatu 5", type: 1, lat: 60.1, lng: 24.9 }
      )
    ).toEqual({
      sijaintiNimi: "Depot A",
      sijaintiOsoite1: "Teollisuuskatu 5",
      sijaintiTypeId: 1,
      lat: 60.1,
      lng: 24.9,
    });
  });

  test("typed flags win over --body keys; untouched body keys are preserved", () => {
    expect(
      buildSijaintiBody(
        { sijaintiNimi: "Old", sijaintiComment: "keep me" },
        { name: "New" }
      )
    ).toEqual({ sijaintiNimi: "New", sijaintiComment: "keep me" });
  });

  test("maps --id to sijaintiId (used by update)", () => {
    expect(buildSijaintiBody({}, { id: 42, name: "X" })).toEqual({
      sijaintiId: 42,
      sijaintiNimi: "X",
    });
  });

  test("maps lyh/maxDeliveryDistance/asiakasId to backend column names", () => {
    expect(
      buildSijaintiBody({}, { name: "Depot", lyh: "DEP", maxDeliveryDistance: 80, asiakasId: 8 })
    ).toEqual({
      sijaintiNimi: "Depot",
      sijaintiLyh: "DEP",
      maxDeliveryDistance: 80,
      asiakasId: 8,
    });
  });
});

describe("applySijaintiCreateDefaults", () => {
  test("defaults sijaintiLyh from sijaintiNimi (≤50 chars) and maxDeliveryDistance to 50", () => {
    const { body, missing } = applySijaintiCreateDefaults({
      sijaintiNimi: "Depot A",
      sijaintiTypeId: 1,
    });
    expect(missing).toEqual([]);
    expect(body.sijaintiLyh).toBe("Depot A");
    expect(body.maxDeliveryDistance).toBe(50);
  });

  test("truncates a long sijaintiNimi to 50 chars for the lyh default", () => {
    const name = "x".repeat(80);
    const { body } = applySijaintiCreateDefaults({ sijaintiNimi: name, sijaintiTypeId: 1 });
    expect(body.sijaintiLyh).toBe("x".repeat(50));
  });

  test("preserves an explicit lyh and maxDeliveryDistance", () => {
    const { body } = applySijaintiCreateDefaults({
      sijaintiNimi: "Depot A",
      sijaintiTypeId: 1,
      sijaintiLyh: "DEP-A",
      maxDeliveryDistance: 120,
    });
    expect(body.sijaintiLyh).toBe("DEP-A");
    expect(body.maxDeliveryDistance).toBe(120);
  });

  test("reports missing required name and type", () => {
    const { missing } = applySijaintiCreateDefaults({});
    expect(missing).toEqual(["--name (sijaintiNimi)", "--type (sijaintiTypeId)"]);
  });
});

describe("runSijaintiSetJerry (delivery radius)", () => {
  const mGet = () => mockClient.get as ReturnType<typeof vi.fn>;
  const mPost = () => mockClient.post as ReturnType<typeof vi.fn>;
  const SENTINEL = "9999-12-31 23:59:59";
  beforeEach(() => {
    mGet().mockReset();
    mPost().mockReset();
  });

  test("--on --radius sets maxDeliveryDistance + the enrol sentinel (other fields preserved)", async () => {
    mGet().mockResolvedValueOnce({ sijaintiId: 42, maxDeliveryDistance: 30, lat: 60 });
    mPost().mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, true, {}, 60);
    expect(mPost().mock.calls[0][1]).toMatchObject({
      sijaintiId: 42, jerryActiveUntil: SENTINEL, maxDeliveryDistance: 60, lat: 60,
    });
  });

  test("--on with no radius defaults maxDeliveryDistance to 50 when the varikko has none", async () => {
    mGet().mockResolvedValueOnce({ sijaintiId: 42, maxDeliveryDistance: 0 });
    mPost().mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, true, {});
    expect(mPost().mock.calls[0][1]).toMatchObject({ maxDeliveryDistance: 50 });
  });

  test("--on preserves an existing maxDeliveryDistance when no radius given", async () => {
    mGet().mockResolvedValueOnce({ sijaintiId: 42, maxDeliveryDistance: 35 });
    mPost().mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, true, {});
    expect(mPost().mock.calls[0][1]).toMatchObject({ maxDeliveryDistance: 35 });
  });

  test("--off clears jerryActiveUntil and leaves the radius untouched", async () => {
    mGet().mockResolvedValueOnce({ sijaintiId: 42, maxDeliveryDistance: 35 });
    mPost().mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, false, {});
    const body = mPost().mock.calls[0][1];
    expect(body.jerryActiveUntil).toBeNull();
    expect(body.maxDeliveryDistance).toBe(35);
  });
});

describe("extractGeocodeLatLng", () => {
  test("reads results[0].geometry.location (raw Google shape)", () => {
    expect(
      extractGeocodeLatLng({ status: "OK", results: [{ geometry: { location: { lat: 60.17, lng: 24.94 } } }] })
    ).toEqual({ lat: 60.17, lng: 24.94 });
  });
  test("falls back to a top-level lat/lng", () => {
    expect(extractGeocodeLatLng({ lat: 60.1, lng: 24.9 })).toEqual({ lat: 60.1, lng: 24.9 });
  });
  test("returns null for ZERO_RESULTS / missing / 0,0", () => {
    expect(extractGeocodeLatLng({ status: "ZERO_RESULTS" })).toBeNull();
    expect(extractGeocodeLatLng({ lat: 0, lng: 0 })).toBeNull();
    expect(extractGeocodeLatLng(null)).toBeNull();
  });
});

describe("ib sijainti delete/undelete", () => {
  beforeEach(() => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runSijaintiDelete: DELETE /api/geocode/sijainti/delete/:id with flag headers", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    const result = await runSijaintiDelete(mockClient, 42, {
      reason: "decommissioned depot",
    });
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/geocode/sijainti/delete/42",
      { headers: { "X-Action-Reason": "decommissioned depot" } }
    );
    expect((result as { success: boolean }).success).toBe(true);
  });

  test("runSijaintiUndelete: POST /api/geocode/sijainti/undelete/:id with empty body + flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    await runSijaintiUndelete(mockClient, 42, { reason: "restored" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/geocode/sijainti/undelete/42",
      {},
      { headers: { "X-Action-Reason": "restored" } }
    );
  });
});
