import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runCustomerList,
  runCustomerGet,
  runCustomerSearch,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib customer list/get/search", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runCustomerList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runCustomerList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/list");
  });

  test("runCustomerList: includes limit and cursor when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ asiakasId: 1349, name: "BetoniJerry" }],
      nextCursor: "abc",
      count: 1,
    });
    const result = await runCustomerList(mockClient, {
      limit: 50,
      cursor: "abc",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/list?limit=50&cursor=abc"
    );
    expect(result.count).toBe(1);
  });

  test("runCustomerGet: GET /api/cli/customer/get/1349", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      asiakasId: 1349,
      name: "BetoniJerry",
    });
    const result = await runCustomerGet(mockClient, 1349);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/get/1349");
    expect((result as { asiakasId: number }).asiakasId).toBe(1349);
  });

  test("runCustomerSearch: GET /api/asiakas/search?q=<query>", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasId: 1349, name: "BetoniJerry" },
    ]);
    await runCustomerSearch(mockClient, "Betoni");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/asiakas/search?q=Betoni"
    );
  });

  test("runCustomerSearch: URL-encodes special characters in query", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runCustomerSearch(mockClient, "Acme & Co");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/asiakas/search?q=Acme+%26+Co"
    );
  });
});
