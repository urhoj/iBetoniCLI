import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runWorksiteCreate,
  runWorksiteUpdate,
  runWorksiteRefreshLocation,
  runWorksiteSetGeofence,
  runWorksiteHelsinkiFetch,
  resolveOwnerAsiakasId,
  buildWorksiteUpdateBody,
} from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { decodeJwtPayload } from "../../src/auth/jwt.js";
vi.mock("../../src/auth/jwt.js", () => ({
  decodeJwtPayload: vi.fn(),
}));

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib worksite create/update", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runWorksiteCreate forwards body + all three write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tyomaaId: 5151,
    });
    const body = { tyomaaNimi: "Helsinki Site A", asiakasId: 1349 };
    const result = await runWorksiteCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-hsinki-a",
      reason: "phase D import",
    });
    expect(mockClient.post).toHaveBeenCalledWith("/api/tyomaa/new", body, {
      headers: {
        "X-Dry-Run": "1",
        "Idempotency-Key": "create-hsinki-a",
        "X-Action-Reason": "phase D import",
      },
    });
    expect((result as { tyomaaId: number }).tyomaaId).toBe(5151);
  });

  test("runWorksiteUpdate uses explicit yyyymmdd when given, defaults to today's YYYYMMDD otherwise", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
    });
    const body = { tyomaaNimi: "Helsinki Site A — renamed" };

    // Explicit yyyymmdd
    await runWorksiteUpdate(
      mockClient,
      { tyomaaId: 5151, ownerAsiakasId: 1349, yyyymmdd: "20260615" },
      body,
      { reason: "naming cleanup" }
    );
    // tyomaaId + ownerAsiakasId are injected so callers only put the
    // fields-to-update in --body (backend validateRequiredFields needs them).
    expect(mockClient.post).toHaveBeenLastCalledWith(
      "/api/tyomaa/set/1349/5151/20260615",
      { tyomaaNimi: "Helsinki Site A — renamed", tyomaaId: 5151, ownerAsiakasId: 1349 },
      { headers: { "X-Action-Reason": "naming cleanup" } }
    );

    // Default yyyymmdd → today, in YYYYMMDD form
    await runWorksiteUpdate(
      mockClient,
      { tyomaaId: 5151, ownerAsiakasId: 1349 },
      body,
      {}
    );
    const lastCall = (mockClient.post as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const url = lastCall[0] as string;
    expect(url).toMatch(/^\/api\/tyomaa\/set\/1349\/5151\/\d{8}$/);
    const today = new Date();
    const expected = `${today.getFullYear()}${String(
      today.getMonth() + 1
    ).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    expect(url.endsWith(expected)).toBe(true);
  });

  test("runWorksiteRefreshLocation: POST refreshLocation with write flags", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await runWorksiteRefreshLocation(mockClient, 42, { reason: "address fix" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/refreshLocation/42",
      {},
      { headers: { "X-Action-Reason": "address fix" } }
    );
  });

  test("runWorksiteSetGeofence: POST geofence-radius with body + dry-run header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await runWorksiteSetGeofence(mockClient, 42, 250, { dryRun: true });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/42/geofence-radius",
      { geofenceRadius: 250 },
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("runWorksiteHelsinkiFetch: POST helsinki/fetch", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await runWorksiteHelsinkiFetch(mockClient, 42, {});
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/helsinki/fetch/42",
      {},
      { headers: {} }
    );
  });

  test("resolveOwnerAsiakasId decodes the active token's ownerAsiakasId", () => {
    (mockClient.getCurrentToken as ReturnType<typeof vi.fn>).mockReturnValue("jwt.token.sig");
    (decodeJwtPayload as ReturnType<typeof vi.fn>).mockReturnValue({ ownerAsiakasId: 1349 });
    expect(resolveOwnerAsiakasId(mockClient)).toBe(1349);
  });

  test("resolveOwnerAsiakasId throws when owner missing", () => {
    (mockClient.getCurrentToken as ReturnType<typeof vi.fn>).mockReturnValue("jwt.token.sig");
    (decodeJwtPayload as ReturnType<typeof vi.fn>).mockReturnValue({ ownerAsiakasId: NaN });
    expect(() => resolveOwnerAsiakasId(mockClient)).toThrow();
  });
});

describe("buildWorksiteUpdateBody (typed-flag merge, fb#234)", () => {
  test("maps typed flags to backend column names", () => {
    expect(
      buildWorksiteUpdateBody({}, {
        name: "Site A",
        comment: "Pickup at gate B",
        address: "Uusikatu 2",
        postalCode: "00100",
        city: "Helsinki",
        invoiceRef: "REF-9",
        contactPerson: 55,
      })
    ).toEqual({
      tyomaaNimi: "Site A",
      tyomaaMemo: "Pickup at gate B",
      tyomaaOsoite1: "Uusikatu 2",
      tyomaaOsoite3: "00100",
      tyomaaOsoite4: "Helsinki",
      laskuViite: "REF-9",
      tyomaaContactPersonId: 55,
    });
  });

  test("omits any field whose flag was not provided (so it is preserved server-side)", () => {
    const body = buildWorksiteUpdateBody({}, { comment: "x" });
    expect(body).toEqual({ tyomaaMemo: "x" });
    expect("tyomaaNimi" in body).toBe(false);
    expect("tyomaaOsoite1" in body).toBe(false);
  });

  test("an explicit empty string is kept (clears the column, not omitted)", () => {
    expect(buildWorksiteUpdateBody({}, { invoiceRef: "" })).toEqual({ laskuViite: "" });
  });

  test("typed flags win over --body keys; uncovered body keys pass through", () => {
    expect(
      buildWorksiteUpdateBody(
        { tyomaaMemo: "from body", rakennusDataJSON: '{"x":1}' },
        { comment: "from flag" }
      )
    ).toEqual({ tyomaaMemo: "from flag", rakennusDataJSON: '{"x":1}' });
  });
});

