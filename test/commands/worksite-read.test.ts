import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runWorksiteList,
  runWorksiteGet,
  runWorksiteSearch,
  runWorksiteMetrics,
  runWorksiteDatesList,
  runWorksiteDatesExpiring,
} from "../../src/commands/worksite/index.js";

const mockClient = mockApiClient();

describe("ib worksite list/get/search", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.post.mockReset();
  });

  test("runWorksiteList: hits bare path when no opts set", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runWorksiteList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/list");
  });

  test("runWorksiteList: includes limit and cursor when set", async () => {
    mockClient.get.mockResolvedValueOnce({
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
    mockClient.get.mockResolvedValueOnce({
      tyomaaId: 42,
      name: "Helsinki Site",
    });
    const result = await runWorksiteGet(mockClient, 42);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/get/42");
    expect((result as { tyomaaId: number }).tyomaaId).toBe(42);
  });

  test("runWorksiteSearch: POSTs /api/tyomaa/search with {searchString} body as a read", async () => {
    mockClient.post.mockResolvedValueOnce([
      { tyomaaId: 42, name: "Helsinki Site" },
    ]);
    await runWorksiteSearch(mockClient, "Helsinki");
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/search",
      { searchString: "Helsinki" },
      { read: true }
    );
  });

  test("runWorksiteSearch: forwards raw query untouched (no encoding)", async () => {
    mockClient.post.mockResolvedValueOnce([]);
    await runWorksiteSearch(mockClient, "Acme & Co");
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/search",
      { searchString: "Acme & Co" },
      { read: true }
    );
  });

  test("runWorksiteList forwards --customer", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runWorksiteList(mockClient, { customer: 1349 });
    const path = mockClient.get.mock.calls[0][0] as string;
    expect(path).toContain("customer=1349");
  });

  test("runWorksiteSearch forwards limit in the body", async () => {
    mockClient.post.mockResolvedValueOnce([]);
    await runWorksiteSearch(mockClient, "Main", 30);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/search",
      { searchString: "Main", limit: 30 },
      { read: true }
    );
  });

  test("runWorksiteMetrics: GET /api/cli/worksite/metrics/42", async () => {
    mockClient.get.mockResolvedValueOnce({
      tyomaaId: 42, summary: { totalM3: 120 }, monthlyBreakdown: [],
    });
    const result = await runWorksiteMetrics(mockClient, 42);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/metrics/42");
    expect((result as { tyomaaId: number }).tyomaaId).toBe(42);
  });

  test("runWorksiteDatesList: GET /api/cli/worksite/dates/42", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runWorksiteDatesList(mockClient, 42);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/dates/42");
  });

  test("runWorksiteDatesExpiring: default days=30", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runWorksiteDatesExpiring(mockClient, undefined);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/dates/expiring?days=30");
  });

  test("runWorksiteDatesExpiring: explicit days", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runWorksiteDatesExpiring(mockClient, 14);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/worksite/dates/expiring?days=14");
  });
});
