import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPerfSlow,
  runPerfStats,
  runPerfConfig,
  runPerfClear,
} from "../../src/commands/perf/index.js";

const mockClient = mockApiClient({ endpoint: "http://127.0.0.1:3000" });

describe("ib perf run* functions", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.delete.mockReset();
  });

  test("runPerfSlow GETs the route with limit+env and projects an envelope", async () => {
    mockClient.get.mockResolvedValueOnce({
      data: {
        queries: [
          { procedure: "keikka_get", duration: 1500, entity: "keikka", params: ["keikkaId"], timestamp: "2026-06-18T00:00:00Z" },
        ],
        count: 1,
        totalCount: 42,
        environment: "production",
      },
    });
    const out = await runPerfSlow(mockClient, { limit: 10, env: "production" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/admin/slow-queries?limit=10&env=production");
    expect(out).toEqual({
      items: [
        { procedure: "keikka_get", durationMs: 1500, entity: "keikka", params: ["keikkaId"], timestamp: "2026-06-18T00:00:00Z" },
      ],
      nextCursor: null,
      count: 1,
      truncated: false,
      totalCount: 42,
      environment: "production",
    });
  });

  test("runPerfSlow flags truncated when the page fills the limit", async () => {
    mockClient.get.mockResolvedValueOnce({
      data: { queries: [{ procedure: "p", duration: 1, entity: "e", params: [], timestamp: "t" }, { procedure: "p2", duration: 2, entity: "e", params: [], timestamp: "t" }], count: 2, totalCount: 99, environment: "production" },
    });
    const out = await runPerfSlow(mockClient, { limit: 2 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/admin/slow-queries?limit=2");
    expect(out.truncated).toBe(true);
  });

  test("runPerfStats unwraps .data", async () => {
    mockClient.get.mockResolvedValueOnce({ data: { totalSlowQueries: 7, avgDuration: 1200 } });
    const out = await runPerfStats(mockClient, { env: "staging" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/admin/slow-queries/stats?env=staging");
    expect(out).toEqual({ totalSlowQueries: 7, avgDuration: 1200 });
  });

  test("runPerfConfig folds in availableEnvironments", async () => {
    mockClient.get
      .mockResolvedValueOnce({ data: { enabled: true, threshold: 1000, maxEntries: 100, environment: "production" } })
      .mockResolvedValueOnce({ data: ["production", "staging"] });
    const out = await runPerfConfig(mockClient);
    expect(mockClient.get).toHaveBeenNthCalledWith(1, "/api/admin/slow-queries/config");
    expect(mockClient.get).toHaveBeenNthCalledWith(2, "/api/admin/slow-queries/environments");
    expect(out).toEqual({ enabled: true, threshold: 1000, maxEntries: 100, environment: "production", availableEnvironments: ["production", "staging"] });
  });

  test("runPerfClear --dry-run resolves client-side (no DELETE)", async () => {
    const out = await runPerfClear(mockClient, { env: "staging", reason: "noise", dryRun: true });
    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(out).toEqual({ dryRun: true, wouldClear: { method: "DELETE", path: "/api/admin/slow-queries?env=staging" } });
  });

  test("runPerfClear executes a DELETE with the reason header", async () => {
    mockClient.delete.mockResolvedValueOnce({ success: true, message: "Slow query buffer cleared" });
    const out = await runPerfClear(mockClient, { env: "staging", reason: "noise" });
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/admin/slow-queries?env=staging",
      { headers: { "X-Action-Reason": "noise" } }
    );
    expect(out).toEqual({ cleared: true, environment: "staging", message: "Slow query buffer cleared" });
  });
});
