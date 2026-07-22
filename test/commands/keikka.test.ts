import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runKeikkaUpdate,
  runKeikkaLatest,
  runKeikkaValidate,
} from "../../src/commands/keikka/index.js";
import { todayHelsinki, addDaysISO } from "../../src/dates.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const getMock = mockClient.get as ReturnType<typeof vi.fn>;

describe("ib keikka update validation", () => {
  test("runKeikkaUpdate throws when no status field is present", async () => {
    await expect(
      runKeikkaUpdate(mockClient, 5, {}, {})
    ).rejects.toThrow(/only supports --status/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });
});

/** Build the backend list envelope for n items. */
function envelope(items: Record<string, unknown>[]) {
  return { items, nextCursor: null, count: items.length };
}

describe("ib keikka latest (windowed backward search)", () => {
  beforeEach(() => getMock.mockReset());

  const today = todayHelsinki();

  test("returns the newest row (pvm, then time) of the first non-empty window", async () => {
    getMock
      .mockResolvedValueOnce(envelope([])) // 7-day window: empty
      .mockResolvedValueOnce(
        envelope([
          { keikkaId: 1, pvm: "2026-05-20", time: "08:00" },
          { keikkaId: 3, pvm: "2026-05-22", time: "14:00" },
          { keikkaId: 2, pvm: "2026-05-22", time: "09:00" },
        ])
      ); // 30-day window: hits
    const result = await runKeikkaLatest(mockClient, { status: "9" });
    expect(result.item).toMatchObject({ keikkaId: 3, pvm: "2026-05-22" });
    expect(result.searched.to).toBe(today);
    expect(getMock).toHaveBeenCalledTimes(2);
    // status filter + 500 cap forwarded to the list endpoint
    expect(String(getMock.mock.calls[0][0])).toMatch(/status=9/);
    expect(String(getMock.mock.calls[0][0])).toMatch(/limit=500/);
  });

  test("windows are contiguous: second window ends the day before the first starts", async () => {
    getMock.mockResolvedValue(envelope([]));
    await runKeikkaLatest(mockClient, { lookback: 60 });
    const url1 = new URL("http://x" + String(getMock.mock.calls[0][0]));
    const url2 = new URL("http://x" + String(getMock.mock.calls[1][0]));
    const firstFrom = url1.searchParams.get("from")!;
    expect(url2.searchParams.get("to")).toBe(addDaysISO(firstFrom, -1));
  });

  test("item:null with the searched range when nothing matches within --lookback", async () => {
    getMock.mockResolvedValue(envelope([]));
    const result = await runKeikkaLatest(mockClient, { lookback: 30 });
    expect(result.item).toBeNull();
    expect(result.searched).toEqual({
      from: addDaysISO(today, -29),
      to: today,
    });
  });

  test("a window truncated at the 500-row cap is halved toward its newest end", async () => {
    const fullPage = envelope(
      Array.from({ length: 500 }, (_, i) => ({ keikkaId: i, pvm: "2026-06-01" }))
    );
    getMock
      .mockResolvedValueOnce(fullPage) // 7-day window: truncated
      .mockResolvedValueOnce(envelope([{ keikkaId: 9, pvm: today }])); // newest half: exact
    const result = await runKeikkaLatest(mockClient, {});
    expect(result.item).toMatchObject({ keikkaId: 9 });
    const url1 = new URL("http://x" + String(getMock.mock.calls[0][0]));
    const url2 = new URL("http://x" + String(getMock.mock.calls[1][0]));
    // same window end, later start
    expect(url2.searchParams.get("to")).toBe(url1.searchParams.get("to"));
    expect(url2.searchParams.get("from")! > url1.searchParams.get("from")!).toBe(true);
  });

  test("--lookback is honoured: stops at the boundary instead of searching further", async () => {
    getMock.mockResolvedValue(envelope([]));
    await runKeikkaLatest(mockClient, { lookback: 10 });
    expect(getMock).toHaveBeenCalledTimes(2); // 7-day window + 3-day remainder
    const last = new URL("http://x" + String(getMock.mock.calls.at(-1)![0]));
    expect(last.searchParams.get("from")).toBe(addDaysISO(today, -9));
  });
});

describe("runKeikkaValidate", () => {
  test("single: GETs /api/cli/keikka/validate/:id", async () => {
    const get = vi.fn().mockResolvedValue({ keikkaId: 9001, isValid: true, issues: [] });
    const client = { get } as unknown as ApiClient;
    const out = await runKeikkaValidate(client, { keikkaId: 9001 });
    expect(get).toHaveBeenCalledWith("/api/cli/keikka/validate/9001");
    expect(out).toEqual({ keikkaId: 9001, isValid: true, issues: [] });
  });

  test("day: GETs /api/cli/keikka/validate?date=", async () => {
    const get = vi.fn().mockResolvedValue({ items: [], count: 0, dayTotals: {} });
    const client = { get } as unknown as ApiClient;
    await runKeikkaValidate(client, { date: "2026-06-18" });
    expect(get).toHaveBeenCalledWith("/api/cli/keikka/validate?date=2026-06-18");
  });
});
