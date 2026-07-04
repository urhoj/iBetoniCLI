import { describe, test, expect, vi, beforeEach } from "vitest";
import { runCustomerDeadList } from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() } as unknown as ApiClient;

describe("ib customer dead-list", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });

  test("hits /api/cli/customer/dead-list and returns the envelope", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ asiakasId: 5, name: "Dead Oy", yTunnus: "0145937-9", prhStatus: "dead", prhSituation: "konkurssi", prhCheckedAt: "2026-07-04T02:00:00Z" }],
      nextCursor: null, count: 1, truncated: false,
    });
    const res = await runCustomerDeadList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/dead-list");
    expect(res.count).toBe(1);
    expect(res.items[0].prhStatus).toBe("dead");
  });

  test("passes --limit as a query param", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runCustomerDeadList(mockClient, { limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/dead-list?limit=50");
  });
});
