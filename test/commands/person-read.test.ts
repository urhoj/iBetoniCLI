import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runPersonList,
  runPersonGet,
  runPersonSearch,
} from "../../src/commands/person/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib person list/get/search", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runPersonList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runPersonList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/list");
  });

  test("runPersonList: includes role/asiakas/limit when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ personId: 6233, name: "BetoniJerry System" }],
      nextCursor: null,
      count: 1,
    });
    const result = await runPersonList(mockClient, {
      role: "kuljettaja",
      asiakas: 1349,
      limit: 50,
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/person/list?role=kuljettaja&asiakas=1349&limit=50"
    );
    expect(result.count).toBe(1);
  });

  test("runPersonGet: GET /api/cli/person/get/6233", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      personId: 6233,
      name: "BetoniJerry System",
    });
    const result = await runPersonGet(mockClient, 6233);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/get/6233");
    expect((result as { personId: number }).personId).toBe(6233);
  });

  test("runPersonSearch: POSTs /api/person/search with {q} body", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personId: 6233, name: "Jerry" },
    ]);
    await runPersonSearch(mockClient, "Jerry");
    expect(mockClient.post).toHaveBeenCalledWith("/api/person/search", {
      q: "Jerry",
    });
  });

  test("runPersonSearch: forwards raw query untouched (no encoding)", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runPersonSearch(mockClient, "Doe & Sons");
    expect(mockClient.post).toHaveBeenCalledWith("/api/person/search", {
      q: "Doe & Sons",
    });
  });
});
