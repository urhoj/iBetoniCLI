import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runWorksiteList,
  runWorksiteGet,
  runWorksiteSearch,
  runWorksiteMetrics,
} from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib worksite list/get/search", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runWorksiteList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runWorksiteList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/list");
  });

  test("runWorksiteList: includes limit and cursor when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ tyomaaId: 42, name: "Helsinki Site" }],
      nextCursor: "next",
      count: 1,
    });
    const result = await runWorksiteList(mockClient, {
      limit: 25,
      cursor: "abc",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/worksite/list?limit=25&cursor=abc"
    );
    expect(result.count).toBe(1);
  });

  test("runWorksiteGet: GET /api/cli/worksite/get/42", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tyomaaId: 42,
      name: "Helsinki Site",
    });
    const result = await runWorksiteGet(mockClient, 42);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/get/42");
    expect((result as { tyomaaId: number }).tyomaaId).toBe(42);
  });

  test("runWorksiteSearch: POSTs /api/tyomaa/search with {searchString} body", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { tyomaaId: 42, name: "Helsinki Site" },
    ]);
    await runWorksiteSearch(mockClient, "Helsinki");
    expect(mockClient.post).toHaveBeenCalledWith("/api/tyomaa/search", {
      searchString: "Helsinki",
    });
  });

  test("runWorksiteSearch: forwards raw query untouched (no encoding)", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runWorksiteSearch(mockClient, "Acme & Co");
    expect(mockClient.post).toHaveBeenCalledWith("/api/tyomaa/search", {
      searchString: "Acme & Co",
    });
  });

  test("runWorksiteMetrics: GET /api/cli/worksite/metrics/42", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tyomaaId: 42, summary: { totalM3: 120 }, monthlyBreakdown: [],
    });
    const result = await runWorksiteMetrics(mockClient, 42);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/metrics/42");
    expect((result as { tyomaaId: number }).tyomaaId).toBe(42);
  });
});
