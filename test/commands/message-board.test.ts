import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  toBoardQueryDate,
  buildBoardFields,
  buildBoardBody,
  runBoardList,
  runBoardAll,
  runBoardGet,
  runBoardCreate,
  runBoardUpdate,
  runBoardDelete,
  type BoardMessage,
} from "../../src/commands/message/board/index.js";
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
const asPut = () => mockClient.put as ReturnType<typeof vi.fn>;
const asDelete = () => mockClient.delete as ReturnType<typeof vi.fn>;

const row = (over: Partial<BoardMessage> = {}): BoardMessage => ({
  messageId: 7,
  ownerAsiakasId: 8,
  title: "Maintenance",
  body: "Plant closed Friday",
  priority: "warning",
  startDate: "2026-06-14",
  expiresAt: "2026-06-20",
  createdBy: 10,
  ...over,
});

beforeEach(() => {
  asGet().mockReset();
  asPost().mockReset();
  asPut().mockReset();
  asDelete().mockReset();
});

describe("toBoardQueryDate — compact YYYYMMDD divergence", () => {
  test("defaults to today as 8 digits when input is undefined", () => {
    const d = toBoardQueryDate(undefined);
    expect(d).toMatch(/^\d{8}$/);
  });

  test("strips dashes from an ISO date", () => {
    expect(toBoardQueryDate("2026-06-14")).toBe("20260614");
  });

  test("passes a bare YYYYMMDD through unchanged", () => {
    expect(toBoardQueryDate("20260614")).toBe("20260614");
  });

  test("expands a relative alias to 8 digits", () => {
    expect(toBoardQueryDate("today")).toMatch(/^\d{8}$/);
  });

  test("returns null for an unparseable value", () => {
    expect(toBoardQueryDate("not-a-date")).toBeNull();
  });
});

describe("buildBoardFields", () => {
  test("maps --text to body and expands relative dates", () => {
    const f = buildBoardFields({
      title: "T",
      text: "B",
      priority: "urgent",
      startDate: "2026-06-14",
      expiresAt: "2026-06-20",
    });
    expect(f).toEqual({
      title: "T",
      body: "B",
      priority: "urgent",
      startDate: "2026-06-14",
      expiresAt: "2026-06-20",
    });
  });

  test('empty --expires-at "" clears the expiry (null), undefined leaves it untouched', () => {
    expect(buildBoardFields({ expiresAt: "" }).expiresAt).toBeNull();
    expect(buildBoardFields({}).expiresAt).toBeUndefined();
  });
});

describe("buildBoardBody — GET-merge keeps untouched columns", () => {
  test("merges changed fields over the current row", () => {
    const merged = buildBoardBody(row(), { title: "New title" });
    expect(merged).toEqual({
      title: "New title",
      body: "Plant closed Friday",
      priority: "warning",
      startDate: "2026-06-14",
      expiresAt: "2026-06-20",
    });
  });

  test("priority falls back to info when neither field nor current row has one", () => {
    const merged = buildBoardBody(null, { title: "T", body: "B", startDate: "2026-06-14" });
    expect(merged.priority).toBe("info");
  });

  test("explicit null expiresAt clears it; undefined preserves the current value", () => {
    expect(buildBoardBody(row(), { expiresAt: null }).expiresAt).toBeNull();
    expect(buildBoardBody(row(), {}).expiresAt).toBe("2026-06-20");
  });

  test("emits only the five writable columns (no server-only fields leak)", () => {
    const merged = buildBoardBody(row(), {});
    expect(Object.keys(merged).sort()).toEqual(
      ["body", "expiresAt", "priority", "startDate", "title"].sort()
    );
  });
});

describe("runBoardList / runBoardAll / runBoardGet", () => {
  test("runBoardList hits the active route with the date param and envelopes the rows", async () => {
    asGet().mockResolvedValueOnce([row()]);
    const res = await runBoardList(mockClient, "20260614");
    expect(mockClient.get).toHaveBeenCalledWith("/api/ilmoitustaulu?date=20260614");
    expect(res).toEqual({ items: [row()], nextCursor: null, count: 1 });
  });

  test("runBoardAll hits /all and envelopes the rows", async () => {
    asGet().mockResolvedValueOnce([row(), row({ messageId: 8 })]);
    const res = await runBoardAll(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/ilmoitustaulu/all");
    expect(res.count).toBe(2);
  });

  test("runBoardGet filters /all client-side (no single-GET route)", async () => {
    asGet().mockResolvedValueOnce([row({ messageId: 7 }), row({ messageId: 9 })]);
    const got = await runBoardGet(mockClient, 9);
    expect(mockClient.get).toHaveBeenCalledWith("/api/ilmoitustaulu/all");
    expect(got?.messageId).toBe(9);
  });

  test("runBoardGet returns null when the id is not in the company set", async () => {
    asGet().mockResolvedValueOnce([row({ messageId: 7 })]);
    expect(await runBoardGet(mockClient, 999)).toBeNull();
  });
});

describe("runBoardCreate", () => {
  const fields = { title: "T", body: "B", priority: "info", startDate: "2026-06-14", expiresAt: null };

  test("--dry-run returns the proposed payload and POSTs nothing", async () => {
    const res = await runBoardCreate(mockClient, fields, { dryRun: true });
    expect(res).toEqual({ dryRun: true, proposed: { ...fields, priority: "info" } });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("a real create POSTs the body with the reason header", async () => {
    asPost().mockResolvedValueOnce(row());
    await runBoardCreate(mockClient, fields, { reason: "scheduled maintenance" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/ilmoitustaulu",
      expect.objectContaining({ title: "T", body: "B", priority: "info", startDate: "2026-06-14" }),
      { headers: { "X-Action-Reason": "scheduled maintenance" } }
    );
  });
});

describe("runBoardUpdate — GET-merge-PUT", () => {
  test("--dry-run returns current + merged proposed and PUTs nothing", async () => {
    asGet().mockResolvedValueOnce([row()]);
    const res = (await runBoardUpdate(mockClient, 7, { title: "New" }, { dryRun: true })) as {
      dryRun: boolean;
      current: BoardMessage;
      proposed: { title: string };
    };
    expect(res.dryRun).toBe(true);
    expect(res.current.messageId).toBe(7);
    expect(res.proposed.title).toBe("New");
    expect(mockClient.put).not.toHaveBeenCalled();
  });

  test("a real update PUTs the full merged row to the id route", async () => {
    asGet().mockResolvedValueOnce([row()]);
    asPut().mockResolvedValueOnce(row({ title: "New" }));
    await runBoardUpdate(mockClient, 7, { title: "New" }, { reason: "typo fix" });
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/ilmoitustaulu/7",
      expect.objectContaining({ title: "New", body: "Plant closed Friday", priority: "warning" }),
      { headers: { "X-Action-Reason": "typo fix" } }
    );
  });

  test("a missing id fails with exit 5 (not-found) and never PUTs", async () => {
    asGet().mockResolvedValueOnce([]);
    await expect(
      runBoardUpdate(mockClient, 404, { title: "x" }, { reason: "r" })
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(mockClient.put).not.toHaveBeenCalled();
  });
});

describe("runBoardDelete", () => {
  test("--dry-run returns wouldDelete and DELETEs nothing", async () => {
    asGet().mockResolvedValueOnce([row()]);
    const res = (await runBoardDelete(mockClient, 7, { dryRun: true })) as {
      dryRun: boolean;
      wouldDelete: BoardMessage;
    };
    expect(res.dryRun).toBe(true);
    expect(res.wouldDelete.messageId).toBe(7);
    expect(mockClient.delete).not.toHaveBeenCalled();
  });

  test("a real delete issues DELETE with the reason header", async () => {
    asGet().mockResolvedValueOnce([row()]);
    asDelete().mockResolvedValueOnce(null);
    await runBoardDelete(mockClient, 7, { reason: "obsolete" });
    expect(mockClient.delete).toHaveBeenCalledWith("/api/ilmoitustaulu/7", {
      headers: { "X-Action-Reason": "obsolete" },
    });
  });

  test("a missing id fails with exit 5 and never DELETEs", async () => {
    asGet().mockResolvedValueOnce([]);
    await expect(runBoardDelete(mockClient, 404, { reason: "r" })).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(mockClient.delete).not.toHaveBeenCalled();
  });
});
