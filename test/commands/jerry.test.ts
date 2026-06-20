import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runJerryRequestList,
  runJerryRequestGet,
  runJerryRequestOffers,
  runJerryRequestCreate,
  runJerryRequestCancel,
  runJerryCounts,
  runJerryCheckAddress,
  runJerryProviderSettingsGet,
  runJerryProviderSettingsSet,
  runJerryAdminList,
  runJerryAdminSearch,
  runJerryAdminDetail,
  runJerryAdminToggle,
  runJerryOfferCreate,
  runJerryOfferSend,
  runJerryOfferAccept,
  runJerryOfferConfirm,
  runJerryOfferWithdraw,
  runJerryAdminRequests,
  runJerryAdminRequestOffers,
} from "../../src/commands/jerry/index.js";
import type { ApiClient } from "../../src/api/client.js";
import type { WriteFlags } from "../../src/api/writeFlags.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const get = mockClient.get as ReturnType<typeof vi.fn>;
const post = mockClient.post as ReturnType<typeof vi.fn>;
const put = mockClient.put as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
});

describe("ib jerry request", () => {
  test("list --mine (default) sends status + limit and wraps in an envelope", async () => {
    get.mockResolvedValueOnce([{ pumppuRequestId: 1 }, { pumppuRequestId: 2 }]);
    const result = await runJerryRequestList(mockClient, {
      status: "open,accepted",
      limit: 50,
    });
    expect(get).toHaveBeenCalledWith(
      "/api/pumppuRequests/mine?status=open%2Caccepted&limit=50"
    );
    expect(result).toEqual({
      items: [{ pumppuRequestId: 1 }, { pumppuRequestId: 2 }],
      nextCursor: null,
      count: 2,
    });
  });

  test("list --mine with no opts hits the bare /mine path", async () => {
    get.mockResolvedValueOnce([]);
    await runJerryRequestList(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/mine");
  });

  test("list --open hits the provider inbox and ignores status/limit", async () => {
    get.mockResolvedValueOnce([{ pumppuRequestId: 9 }]);
    const result = await runJerryRequestList(mockClient, {
      open: true,
      status: "open",
      limit: 10,
    });
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/open");
    expect(result.count).toBe(1);
  });

  test("list tolerates a non-array body (empty envelope)", async () => {
    get.mockResolvedValueOnce(null);
    const result = await runJerryRequestList(mockClient, {});
    expect(result).toEqual({ items: [], nextCursor: null, count: 0 });
  });

  test("list --open --all forwards ?scope=all and uses the backend truncated flag", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ pumppuRequestId: i + 1, distanceKm: i, isOutOfArea: true }));
    get.mockResolvedValueOnce({ requests: rows, truncated: true });
    const result = await runJerryRequestList(mockClient, { open: true, all: true });
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/open?scope=all");
    expect(result.count).toBe(200);
    expect(result.truncated).toBe(true);
  });

  test("list --open --all reports truncated=false at exactly the cap (no false positive)", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ pumppuRequestId: i + 1 }));
    get.mockResolvedValueOnce({ requests: rows, truncated: false });
    const result = await runJerryRequestList(mockClient, { open: true, all: true });
    expect(result.count).toBe(200);
    expect(result.truncated).toBe(false);
  });

  test("list --open without --all does not set truncated", async () => {
    get.mockResolvedValueOnce([{ pumppuRequestId: 1 }]);
    const result = await runJerryRequestList(mockClient, { open: true });
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/open");
    expect(result.truncated).toBeUndefined();
  });

  test("list --all without --open exits 4 (no silent no-op)", async () => {
    await expect(runJerryRequestList(mockClient, { all: true })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  test("get (default) hits the customer recap path", async () => {
    get.mockResolvedValueOnce({ pumppuRequestId: 4012 });
    await runJerryRequestGet(mockClient, 4012, false);
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/4012");
  });

  test("get --provider hits the provider-detail path", async () => {
    get.mockResolvedValueOnce({ request: {} });
    await runJerryRequestGet(mockClient, 4012, true);
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/4012/provider-detail");
  });

  test("offers hits /:id/offers and wraps in an envelope", async () => {
    get.mockResolvedValueOnce([{ pumppuOfferId: 7 }]);
    const result = await runJerryRequestOffers(mockClient, 4012);
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/4012/offers");
    expect(result).toEqual({
      items: [{ pumppuOfferId: 7 }],
      nextCursor: null,
      count: 1,
    });
  });

  test("create posts the mapped body and forwards the reason header", async () => {
    post.mockResolvedValueOnce({ pumppuRequestId: 7, status: "open" });
    await runJerryRequestCreate(
      mockClient,
      { osoite: "Mannerheimintie 1, Helsinki", pumppausaika: "2026-06-17T09:00:00+03:00", maaraM3: 30, puomi: 24 },
      { reason: "tilaus" }
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests",
      { osoite: "Mannerheimintie 1, Helsinki", pumppausaika: "2026-06-17T09:00:00+03:00", maaraM3: 30, puomi: 24 },
      { headers: { "X-Action-Reason": "tilaus" } }
    );
  });

  test("create forwards --dry-run as X-Dry-Run", async () => {
    post.mockResolvedValueOnce({ dryRun: true });
    await runJerryRequestCreate(
      mockClient,
      { osoite: "A 1", pumppausaika: "2026-06-17T09:00:00+03:00", maaraM3: 30 },
      { dryRun: true, reason: "preview" }
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests",
      { osoite: "A 1", pumppausaika: "2026-06-17T09:00:00+03:00", maaraM3: 30 },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "preview" } }
    );
  });
});

describe("ib jerry counts", () => {
  test("default (mine) hits /mine/counts", async () => {
    get.mockResolvedValueOnce({ open: 3 });
    await runJerryCounts(mockClient, false);
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/mine/counts");
  });

  test("--provider hits /provider-counts", async () => {
    get.mockResolvedValueOnce({ avoimet: 5 });
    await runJerryCounts(mockClient, true);
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/provider-counts");
  });
});

describe("ib jerry check-address", () => {
  test("maps --address to osoite and includes only supplied coords", async () => {
    post.mockResolvedValueOnce({ geocoded: true, deliverable: true });
    await runJerryCheckAddress(mockClient, {
      address: "Mannerheimintie 1, Helsinki",
      lat: 60.17,
      lng: 24.94,
      placeId: "ChIJabc",
    });
    expect(post).toHaveBeenCalledWith("/api/pumppuRequests/checkAddress", {
      osoite: "Mannerheimintie 1, Helsinki",
      lat: 60.17,
      lng: 24.94,
      placeId: "ChIJabc",
    }, { read: true });
  });

  test("address-only body omits coord keys", async () => {
    post.mockResolvedValueOnce({ geocoded: true });
    await runJerryCheckAddress(mockClient, { address: "Hämeenkatu 1, Tampere" });
    expect(post).toHaveBeenCalledWith("/api/pumppuRequests/checkAddress", {
      osoite: "Hämeenkatu 1, Tampere",
    }, { read: true });
  });
});

describe("ib jerry provider-settings", () => {
  test("get without --asiakas hits the bare path", async () => {
    get.mockResolvedValueOnce({ asiakasId: 1402 });
    await runJerryProviderSettingsGet(mockClient, undefined);
    expect(get).toHaveBeenCalledWith("/api/jerry-provider-settings");
  });

  test("get with --asiakas appends the query param", async () => {
    get.mockResolvedValueOnce({ asiakasId: 1402 });
    await runJerryProviderSettingsGet(mockClient, 1402);
    expect(get).toHaveBeenCalledWith("/api/jerry-provider-settings?asiakasId=1402");
  });

  test("set PUTs the body, merges --asiakas, and forwards write-flag headers", async () => {
    put.mockResolvedValueOnce({ asiakasId: 1402 });
    await runJerryProviderSettingsSet(
      mockClient,
      { openingHours: "ma-pe 7-16" },
      1402,
      { dryRun: true, reason: "update hours" }
    );
    expect(put).toHaveBeenCalledWith(
      "/api/jerry-provider-settings",
      { openingHours: "ma-pe 7-16", asiakasId: 1402 },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "update hours" } }
    );
  });

  test("set without --asiakas leaves the body untouched", async () => {
    put.mockResolvedValueOnce({ asiakasId: 1 });
    await runJerryProviderSettingsSet(
      mockClient,
      { maintainsOrderInfo: false },
      undefined,
      { reason: "x" }
    );
    expect(put).toHaveBeenCalledWith(
      "/api/jerry-provider-settings",
      { maintainsOrderInfo: false },
      { headers: { "X-Action-Reason": "x" } }
    );
  });
});

describe("ib jerry admin", () => {
  test("list wraps the company array in an envelope", async () => {
    get.mockResolvedValueOnce([{ asiakasId: 1402, asiakasNimi: "Acme" }]);
    const result = await runJerryAdminList(mockClient);
    expect(get).toHaveBeenCalledWith("/api/admin/jerry-companies");
    expect(result.count).toBe(1);
  });

  test("search url-encodes the query", async () => {
    get.mockResolvedValueOnce([]);
    await runJerryAdminSearch(mockClient, "Betoni Oy");
    expect(get).toHaveBeenCalledWith(
      "/api/admin/jerry-companies/search?q=Betoni%20Oy"
    );
  });

  test("detail hits the drill-down path", async () => {
    get.mockResolvedValueOnce({ admins: [] });
    await runJerryAdminDetail(mockClient, 1402);
    expect(get).toHaveBeenCalledWith("/api/admin/jerry-companies/1402/detail");
  });

  test("enable posts to /enable with write-flag headers", async () => {
    post.mockResolvedValueOnce({ success: true });
    await runJerryAdminToggle(mockClient, 1402, true, { reason: "onboard" });
    expect(post).toHaveBeenCalledWith(
      "/api/admin/jerry-companies/1402/enable",
      {},
      { headers: { "X-Action-Reason": "onboard" } }
    );
  });

  test("disable posts to /disable", async () => {
    post.mockResolvedValueOnce({ success: true });
    await runJerryAdminToggle(mockClient, 1402, false, { dryRun: true });
    expect(post).toHaveBeenCalledWith(
      "/api/admin/jerry-companies/1402/disable",
      {},
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("admin requests forwards filters and wraps requests in an envelope", async () => {
    get.mockResolvedValueOnce({ requests: [{ pumppuRequestId: 1 }], truncated: false });
    const result = await runJerryAdminRequests(mockClient, { status: "open,accepted", customer: 5 });
    expect(get).toHaveBeenCalledWith(
      "/api/admin/jerry-requests?status=open%2Caccepted&customerId=5"
    );
    expect(result).toEqual({ items: [{ pumppuRequestId: 1 }], nextCursor: null, count: 1, truncated: false });
  });

  test("admin request-offers wraps the offers array", async () => {
    get.mockResolvedValueOnce([{ pumppuOfferId: 9 }]);
    const result = await runJerryAdminRequestOffers(mockClient, 1);
    expect(get).toHaveBeenCalledWith("/api/admin/jerry-requests/1/offers");
    expect(result.count).toBe(1);
  });
});

describe("ib jerry offer", () => {
  test("create posts the body and forwards the reason header", async () => {
    post.mockResolvedValueOnce({ pumppuOfferId: 55, status: "draft" });
    await runJerryOfferCreate(
      mockClient,
      4012,
      { priceCents: 45000, vatPercent: 25.5, maintainsOrderInfo: false },
      { reason: "tarjous" }
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/4012/offers",
      { priceCents: 45000, vatPercent: 25.5, maintainsOrderInfo: false },
      { headers: { "X-Action-Reason": "tarjous" } }
    );
  });

  test("create forwards --dry-run as X-Dry-Run", async () => {
    post.mockResolvedValueOnce({ dryRun: true });
    await runJerryOfferCreate(
      mockClient,
      4012,
      { priceCents: 1 },
      { dryRun: true, reason: "preview" }
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/4012/offers",
      { priceCents: 1 },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "preview" } }
    );
  });

  test("send posts to /send with an empty body + reason header", async () => {
    post.mockResolvedValueOnce({ status: "pending" });
    await runJerryOfferSend(mockClient, 4012, 55, { reason: "send" });
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/4012/offers/55/send",
      {},
      { headers: { "X-Action-Reason": "send" } }
    );
  });

  test("accept posts to /accept", async () => {
    post.mockResolvedValueOnce({ status: "accepted" });
    await runJerryOfferAccept(mockClient, 4012, 55, { reason: "accept" });
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/4012/offers/55/accept",
      {},
      { headers: { "X-Action-Reason": "accept" } }
    );
  });

  test("confirm posts scheduledAt + pumppuId with the reason header", async () => {
    post.mockResolvedValueOnce({ status: "confirmed", keikkaId: 9 });
    await runJerryOfferConfirm(
      mockClient,
      4012,
      55,
      { scheduledAt: "2026-06-15T08:00:00Z", pumppuId: 7 },
      { reason: "confirm" }
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/4012/offers/55/confirm",
      { scheduledAt: "2026-06-15T08:00:00Z", pumppuId: 7 },
      { headers: { "X-Action-Reason": "confirm" } }
    );
  });
});

describe("ib jerry request cancel", () => {
  test("request cancel posts to /:id/cancel with write headers", async () => {
    post.mockResolvedValueOnce({ success: true, status: "cancelled" });
    const result = await runJerryRequestCancel(mockClient, 88, { reason: "peruttu" } as WriteFlags);
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/88/cancel",
      {},
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(result).toEqual({ success: true, status: "cancelled" });
  });
});

describe("ib jerry offer withdraw", () => {
  test("offer withdraw posts to /:id/offers/:offerId/withdraw with headers", async () => {
    post.mockResolvedValueOnce({ success: true, status: "withdrawn" });
    const result = await runJerryOfferWithdraw(mockClient, 77, 5, { reason: "peruttu" } as WriteFlags);
    expect(post).toHaveBeenCalledWith(
      "/api/pumppuRequests/77/offers/5/withdraw",
      {},
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(result).toEqual({ success: true, status: "withdrawn" });
  });
});

describe("ib jerry request list --provider", () => {
  test("list --provider --tab tarjotut hits provider-list and unwraps requests", async () => {
    get.mockResolvedValueOnce({ counts: {}, requests: [{ pumppuRequestId: 5 }] });
    const result = await runJerryRequestList(mockClient, { provider: true, tab: "tarjotut" });
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/provider-list?tab=tarjotut");
    expect(result.count).toBe(1);
  });

  test("list --provider defaults to tab=avoimet", async () => {
    get.mockResolvedValueOnce({ counts: {}, requests: [] });
    await runJerryRequestList(mockClient, { provider: true });
    expect(get).toHaveBeenCalledWith("/api/pumppuRequests/provider-list?tab=avoimet");
  });
});
