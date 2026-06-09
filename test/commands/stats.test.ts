import { describe, test, expect, vi, beforeEach } from "vitest";
import { runStats, resolveStatsPeriod } from "../../src/commands/stats/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;

beforeEach(() => {
  (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ totals: { orders: 0, m3: 0 } });
});

describe("resolveStatsPeriod", () => {
  test("--month expands to first/last day", () => {
    expect(resolveStatsPeriod({ month: "2026-06" })).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
  test("--week expands to 7-day window (alias resolved)", () => {
    expect(resolveStatsPeriod({ week: "2026-06-08" })).toEqual({ from: "2026-06-08", to: "2026-06-14" });
  });
  test("--from/--to pass through (aliases resolved)", () => {
    expect(resolveStatsPeriod({ from: "2026-06-01", to: "2026-06-30" })).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
  test("rejects combining period flags", () => {
    expect(() => resolveStatsPeriod({ month: "2026-06", today: true })).toThrow();
    expect(() => resolveStatsPeriod({ month: "2026-06", from: "2026-06-01", to: "2026-06-02" })).toThrow();
  });
  test("rejects from without to", () => {
    expect(() => resolveStatsPeriod({ from: "2026-06-01" })).toThrow();
  });
});

describe("runStats", () => {
  test("builds /api/cli/stats query with from/to", async () => {
    await runStats(mockClient, { from: "2026-06-01", to: "2026-06-30" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/stats?from=2026-06-01&to=2026-06-30");
  });
  test("appends &by= when --by given", async () => {
    await runStats(mockClient, { month: "2026-06", by: "customer" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/stats?from=2026-06-01&to=2026-06-30&by=customer");
  });
  test("rejects an unknown --by before any network call", async () => {
    await expect(runStats(mockClient, { month: "2026-06", by: "bogus" })).rejects.toThrow();
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});
