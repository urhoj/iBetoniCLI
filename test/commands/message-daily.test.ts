import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  toYyyymmdd,
  runDailyList,
  runDailyGet,
  runDailySetMessage,
  runDailySaveBox,
  runDailyAddBox,
  runDailyDeleteBox,
  runDailyShare,
  runDailyGrant,
  runDailyPermSet,
} from "../../src/commands/message/daily/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const asGet = () => mockClient.get as ReturnType<typeof vi.fn>;
const asPost = () => mockClient.post as ReturnType<typeof vi.fn>;
const asDelete = () => mockClient.delete as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toYyyymmdd", () => {
  test("passes through bare YYYYMMDD and the 00000000 default-box sentinel", () => {
    expect(toYyyymmdd("20260614")).toBe("20260614");
    expect(toYyyymmdd("00000000")).toBe("00000000");
  });

  test("strips dashes from YYYY-MM-DD", () => {
    expect(toYyyymmdd("2026-06-14")).toBe("20260614");
  });

  test("rejects garbage with exit 4", () => {
    expect(() => toYyyymmdd("not-a-date")).toThrowError();
  });
});

describe("runDailyList", () => {
  test("hits /box/list/:asiakasId, appends ?yyyymmdd, strips success", async () => {
    asGet().mockResolvedValue({ success: true, boxes: [{ boxId: 1 }], messages: [], boxPermissions: [] });
    const res = await runDailyList(mockClient, 8, "20260614");
    expect(asGet()).toHaveBeenCalledWith("/api/dailyMessage/box/list/8?yyyymmdd=20260614");
    expect(res).toEqual({ boxes: [{ boxId: 1 }], messages: [], boxPermissions: [] });
  });

  test("omits the query string when no date is given", async () => {
    asGet().mockResolvedValue({ success: true, boxes: [], messages: [], boxPermissions: [] });
    await runDailyList(mockClient, 8);
    expect(asGet()).toHaveBeenCalledWith("/api/dailyMessage/box/list/8");
  });
});

describe("runDailyGet", () => {
  test("filters the composite to one box + its message + its permissions", async () => {
    asGet().mockResolvedValue({
      success: true,
      boxes: [{ boxId: 1 }, { boxId: 36 }],
      messages: [{ boxId: 36, message: "hei" }],
      boxPermissions: [{ boxId: 36, asiakasPersonSettingTypeId: 8 }, { boxId: 1 }],
    });
    const res = await runDailyGet(mockClient, 8, 36, "20260614");
    expect(res.box).toEqual({ boxId: 36 });
    expect(res.message).toEqual({ boxId: 36, message: "hei" });
    expect(res.permissions).toEqual([{ boxId: 36, asiakasPersonSettingTypeId: 8 }]);
  });

  test("exits 5 when the box is not visible for the company", async () => {
    asGet().mockResolvedValue({ success: true, boxes: [{ boxId: 1 }], messages: [], boxPermissions: [] });
    await expect(runDailyGet(mockClient, 8, 999)).rejects.toMatchObject({ exitCode: 5 });
  });
});

describe("daily writes", () => {
  test("set posts message content + carries the reason header", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailySetMessage(
      mockClient,
      { boxId: 36, message: "Asema kiinni", yyyymmdd: "20260614" },
      { reason: "tiedote" }
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/message/save",
      { boxId: 36, message: "Asema kiinni", yyyymmdd: "20260614" },
      { headers: { "X-Action-Reason": "tiedote" } }
    );
  });

  test("set with message:null clears the day", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailySetMessage(mockClient, { boxId: 36, message: null, yyyymmdd: "00000000" }, {});
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/message/save",
      { boxId: 36, message: null, yyyymmdd: "00000000" },
      { headers: {} }
    );
  });

  test("save edits box metadata", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailySaveBox(mockClient, { boxId: 36, boxTitle: "Tiedotteet", boxLisatieto: null }, {});
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/save",
      { boxId: 36, boxTitle: "Tiedotteet", boxLisatieto: null },
      { headers: {} }
    );
  });

  test("add default mode posts ownerAsiakasId to /box/add/:yyyymmdd (default 00000000)", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailyAddBox(mockClient, { init: false, ownerAsiakasId: 8, boxTitle: "T" }, {});
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/add/00000000",
      { ownerAsiakasId: 8, boxTitle: "T" },
      { headers: {} }
    );
  });

  test("add --init hits /box/initialize and never sends ownerAsiakasId", async () => {
    asPost().mockResolvedValue({ success: true, created: true });
    await runDailyAddBox(mockClient, { init: true, ownerAsiakasId: 8 }, {});
    expect(asPost()).toHaveBeenCalledWith("/api/dailyMessage/box/initialize", {}, { headers: {} });
  });

  test("delete hits /box/delete/:boxId", async () => {
    asDelete().mockResolvedValue({ success: true });
    await runDailyDeleteBox(mockClient, 36, { reason: "cleanup" });
    expect(asDelete()).toHaveBeenCalledWith("/api/dailyMessage/box/delete/36", {
      headers: { "X-Action-Reason": "cleanup" },
    });
  });

  test("share posts boxId + asiakasId", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailyShare(mockClient, { boxId: 36, asiakasId: 26 }, {});
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/asiakas/add",
      { boxId: 36, asiakasId: 26 },
      { headers: {} }
    );
  });

  test("grant posts the full ACL tuple", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailyGrant(
      mockClient,
      { boxId: 36, asiakasId: 8, asiakasPersonSettingTypeId: 8, dailyMessageBoxAsiakasId: 34 },
      {}
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/asiakas/permission/add",
      { boxId: 36, asiakasId: 8, asiakasPersonSettingTypeId: 8, dailyMessageBoxAsiakasId: 34 },
      { headers: {} }
    );
  });

  test("perm-set maps access read→readOnly:true", async () => {
    asPost().mockResolvedValue({ success: true });
    await runDailyPermSet(
      mockClient,
      { dailyMessageBoxAsiakasPermissionsId: 111, asiakasPersonSettingTypeId: 8, readOnly: true },
      {}
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/dailyMessage/box/asiakas/permission/save",
      { dailyMessageBoxAsiakasPermissionsId: 111, asiakasPersonSettingTypeId: 8, readOnly: true },
      { headers: {} }
    );
  });
});

describe("daily --dry-run is client-side (no write leaves the process)", () => {
  test("set previews and never POSTs (routes have no X-Dry-Run guard)", async () => {
    const res = await runDailySetMessage(
      mockClient,
      { boxId: 36, message: "x", yyyymmdd: "20260614" },
      { dryRun: true }
    );
    expect(res).toEqual({ dryRun: true, wouldSet: { boxId: 36, message: "x", yyyymmdd: "20260614" } });
    expect(asPost()).not.toHaveBeenCalled();
  });

  test("add --init previews and never POSTs", async () => {
    const res = await runDailyAddBox(mockClient, { init: true, boxTitle: "T" }, { dryRun: true });
    expect(res).toEqual({
      dryRun: true,
      wouldAdd: { path: "/api/dailyMessage/box/initialize", body: { boxTitle: "T" } },
    });
    expect(asPost()).not.toHaveBeenCalled();
  });

  test("delete previews and never DELETEs", async () => {
    const res = await runDailyDeleteBox(mockClient, 36, { dryRun: true, reason: "r" });
    expect(res).toEqual({ dryRun: true, wouldDelete: { boxId: 36 } });
    expect(asDelete()).not.toHaveBeenCalled();
  });

  test("perm-set previews and never POSTs", async () => {
    const res = await runDailyPermSet(
      mockClient,
      { dailyMessageBoxAsiakasPermissionsId: 111, asiakasPersonSettingTypeId: 8, readOnly: false },
      { dryRun: true }
    );
    expect(res).toEqual({
      dryRun: true,
      wouldPermSet: { dailyMessageBoxAsiakasPermissionsId: 111, asiakasPersonSettingTypeId: 8, readOnly: false },
    });
    expect(asPost()).not.toHaveBeenCalled();
  });
});
