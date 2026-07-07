import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiCreate,
  runSijaintiUpdate,
  runSijaintiDelete,
  runSijaintiUndelete,
  runSijaintiSetJerry,
  runSijaintiSaveLatLng,
  persistSijaintiCoords,
  applyGeocodeToBody,
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
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
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

  test("runSijaintiUpdate read-merges (fb#93): GET current row, sparse fields overlaid, jerryActiveUntil/dates preserved, coords stripped", async () => {
    const current = {
      sijaintiId: 4242,
      sijaintiNimi: "Helsinki HQ",
      sijaintiOsoite1: "Mannerheimintie 1",
      sijaintiOsoite2: "00100 Helsinki",
      sijaintiPhone: "+358401234567",
      jerryActiveUntil: "9999-12-31T23:59:59.000Z",
      startDate: "2024-01-01",
      endDate: null,
      maxDeliveryDistance: 60,
      lat: 60.17,
      lng: 24.94,
      placeId: "ChIJxyz",
    };
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(current);
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    const sparse = { sijaintiId: 4242, sijaintiNimi: "Helsinki HQ — Tower B" };
    const { result, merged } = await runSijaintiUpdate(mockClient, sparse, {
      reason: "tower split",
    });
    expect(mockClient.get).toHaveBeenCalledWith("/api/geocode/sijainti/get/4242");
    // one POST only (no geocode — address unchanged), sijaintiId IN body (not URL)
    expect(mockClient.post).toHaveBeenCalledTimes(1);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/geocode/updateSijainti",
      {
        sijaintiId: 4242,
        sijaintiNimi: "Helsinki HQ — Tower B",
        sijaintiOsoite1: "Mannerheimintie 1",
        sijaintiOsoite2: "00100 Helsinki",
        sijaintiPhone: "+358401234567",
        jerryActiveUntil: "9999-12-31T23:59:59.000Z",
        startDate: "2024-01-01",
        endDate: null,
        maxDeliveryDistance: 60,
      },
      { headers: { "X-Action-Reason": "tower split" } }
    );
    // lat/lng/placeId never ride the save body (persisted separately via updateLatLng)
    expect(merged.lat).toBeUndefined();
    expect(merged.lng).toBeUndefined();
    expect((result as { success: boolean }).success).toBe(true);
  });

  test("runSijaintiUpdate: explicit null in the sparse body still clears the field", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 7,
      sijaintiNimi: "Depot",
      sijaintiOsoite1: "Street 1",
      endDate: "2026-12-31",
    });
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    const { merged } = await runSijaintiUpdate(
      mockClient,
      { sijaintiId: 7, endDate: null },
      {}
    );
    expect(merged.endDate).toBeNull();
    expect(merged.sijaintiNimi).toBe("Depot");
  });

  test("runSijaintiUpdate: address change without coords auto-geocodes the NEW address", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 7,
      sijaintiNimi: "Depot",
      sijaintiOsoite1: "Old Street 1",
      lat: 60.1,
      lng: 24.9,
    });
    const post = mockClient.post as ReturnType<typeof vi.fn>;
    post.mockImplementation(async (path: string) => {
      if (path === "/api/geocode/getLatLng") {
        return { results: [{ geometry: { location: { lat: 61.5, lng: 23.75 } } }] };
      }
      return { success: true };
    });
    const { merged, geocodeFailed } = await runSijaintiUpdate(
      mockClient,
      { sijaintiId: 7, sijaintiOsoite1: "New Street 2, Tampere" },
      {}
    );
    expect(post).toHaveBeenCalledWith("/api/geocode/getLatLng", {
      osoite: "New Street 2, Tampere",
    });
    expect(merged.lat).toBe(61.5);
    expect(merged.lng).toBe(23.75);
    expect(geocodeFailed).toBeUndefined();
  });

  test("runSijaintiUpdate: auto-geocode failure is soft — update still POSTs, geocodeFailed reported", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 7,
      sijaintiNimi: "Depot",
      sijaintiOsoite1: "Old Street 1",
    });
    const post = mockClient.post as ReturnType<typeof vi.fn>;
    post.mockImplementation(async (path: string) => {
      if (path === "/api/geocode/getLatLng") return { status: "ZERO_RESULTS" };
      return { success: true };
    });
    const { merged, geocodeFailed } = await runSijaintiUpdate(
      mockClient,
      { sijaintiId: 7, sijaintiOsoite1: "Nonexistent Road 999" },
      {}
    );
    expect(geocodeFailed).toContain("could not geocode");
    expect(merged.lat).toBeUndefined();
    expect(post).toHaveBeenCalledWith(
      "/api/geocode/updateSijainti",
      expect.objectContaining({ sijaintiOsoite1: "Nonexistent Road 999" }),
      { headers: {} }
    );
  });

  test("runSijaintiUpdate: explicit --lat/--lng suppress the auto-geocode on address change", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 7,
      sijaintiOsoite1: "Old Street 1",
    });
    const post = mockClient.post as ReturnType<typeof vi.fn>;
    post.mockResolvedValue({ success: true });
    const { merged } = await runSijaintiUpdate(
      mockClient,
      { sijaintiId: 7, sijaintiOsoite1: "New Street 2", lat: 61.5, lng: 23.75 },
      {}
    );
    expect(post).toHaveBeenCalledTimes(1); // updateSijainti only — no getLatLng
    expect(merged.lat).toBe(61.5);
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

describe("applyGeocodeToBody (--geocode, shared by create/update)", () => {
  const mPost = () => mockClient.post as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mPost().mockReset();
  });

  test("geocodes sijaintiOsoite1 and sets body.lat/lng", async () => {
    mPost().mockResolvedValueOnce({
      status: "OK",
      results: [{ geometry: { location: { lat: 60.17, lng: 24.94 } } }],
    });
    const body: Record<string, unknown> = { sijaintiOsoite1: "Mannerheimintie 1, Helsinki" };
    await applyGeocodeToBody(mockClient, body);
    expect(mPost()).toHaveBeenCalledWith("/api/geocode/getLatLng", {
      osoite: "Mannerheimintie 1, Helsinki",
    });
    expect(body).toMatchObject({ lat: 60.17, lng: 24.94 });
  });

  test("no-op (no geocode call) when coords already present", async () => {
    const body: Record<string, unknown> = { sijaintiOsoite1: "X", lat: 1, lng: 2 };
    await applyGeocodeToBody(mockClient, body);
    expect(mPost()).not.toHaveBeenCalled();
    expect(body).toEqual({ sijaintiOsoite1: "X", lat: 1, lng: 2 });
  });

  test("exit 4 when no address to geocode", async () => {
    await expect(applyGeocodeToBody(mockClient, {})).rejects.toThrow(/requires --address/);
    expect(mPost()).not.toHaveBeenCalled();
  });

  test("exit 4 when the address has no match (ZERO_RESULTS)", async () => {
    mPost().mockResolvedValueOnce({ status: "ZERO_RESULTS" });
    await expect(
      applyGeocodeToBody(mockClient, { sijaintiOsoite1: "asdf" })
    ).rejects.toThrow(/could not geocode/);
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

  test("maps puomiMin/puomiMax to backend names", () => {
    expect(buildSijaintiBody({}, { puomiMin: 20, puomiMax: 42 })).toEqual({
      puomiMin: 20,
      puomiMax: 42,
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

  test("--on with boom range writes puomiMin/puomiMax onto the merged body", async () => {
    mGet().mockResolvedValueOnce({ sijaintiId: 42 });
    mPost().mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, true, {}, undefined, { min: 20, max: 42 });
    const [, body] = mPost().mock.calls[0];
    expect((body as Record<string, unknown>).puomiMin).toBe(20);
    expect((body as Record<string, unknown>).puomiMax).toBe(42);
  });

  test("boom bounds omitted → body keeps the current row's values untouched", async () => {
    mGet().mockResolvedValueOnce({ sijaintiId: 42 });
    mPost().mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, true, {});
    const [, body] = mPost().mock.calls[0];
    expect((body as Record<string, unknown>).puomiMin).toBeUndefined();
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
