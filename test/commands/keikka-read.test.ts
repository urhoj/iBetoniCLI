import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runKeikkaList,
  runKeikkaGet,
  resolveDate,
} from "../../src/commands/keikka/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib keikka list/get", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runKeikkaList: builds URL with from/to query params", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ keikkaId: 1, pvm: "2026-06-01" }],
      nextCursor: null,
      count: 1,
    });
    const result = await runKeikkaList(mockClient, {
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/keikka/list?from=2026-06-01&to=2026-06-30"
    );
    expect(result.count).toBe(1);
    // The interpreted date window is echoed so an empty result is verifiably scoped.
    expect(result.range).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });

  test("runKeikkaList: range echoes null when no dates were sent", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    const result = await runKeikkaList(mockClient, {});
    expect(result.range).toEqual({ from: null, to: null });
  });

  test("runKeikkaList: includes customer/vehicle/status/limit/cursor when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runKeikkaList(mockClient, {
      from: "2026-06-01",
      to: "2026-06-30",
      customer: 1349,
      vehicle: 7,
      status: "1",
      limit: 50,
      cursor: "abc",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/keikka/list?from=2026-06-01&to=2026-06-30&customer=1349&vehicle=7&status=1&limit=50&cursor=abc"
    );
  });

  test("runKeikkaList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runKeikkaList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/keikka/list");
  });

  test("runKeikkaList: includes worksite as tyomaaId filter", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runKeikkaList(mockClient, { from: "2026-06-01", to: "2026-06-30", worksite: 42 });
    const url = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("worksite=42");
  });

  test("runKeikkaGet: GET /api/cli/keikka/get/9001", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      keikkaId: 9001,
      pvm: "2026-06-01",
    });
    const result = await runKeikkaGet(mockClient, 9001);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/keikka/get/9001");
    expect(result.keikkaId).toBe(9001);
  });
});

describe("resolveDate", () => {
  // Pin the clock: resolveDate works on the Europe/Helsinki calendar day, so
  // comparing against a live UTC toISOString() date flakes daily between
  // 21:00–24:00 UTC (00:00–03:00 Helsinki). 23:30 UTC = 02:30 next day in
  // Helsinki (DST +3) — deliberately inside the old flake window.
  afterEach(() => {
    vi.useRealTimers();
  });

  test("undefined passes through", () => {
    expect(resolveDate(undefined)).toBeUndefined();
  });

  test("'today' returns the Helsinki ISO date for today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T23:30:00Z"));
    expect(resolveDate("today")).toBe("2026-06-02");
  });

  test("'yesterday' returns the Helsinki ISO date for yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T23:30:00Z"));
    expect(resolveDate("yesterday")).toBe("2026-06-01");
  });

  test("'tomorrow' returns the Helsinki ISO date for tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T23:30:00Z"));
    expect(resolveDate("tomorrow")).toBe("2026-06-03");
  });

  test("explicit ISO date passes through", () => {
    expect(resolveDate("2026-06-15")).toBe("2026-06-15");
  });

  test("unknown alias passes through unchanged", () => {
    expect(resolveDate("last-week")).toBe("last-week");
  });
});
