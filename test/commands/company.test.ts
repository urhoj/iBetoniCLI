import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runCompanyList,
  runCompanyCurrent,
} from "../../src/commands/company/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib company", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runCompanyList: GETs /api/company-selection/available and projects envelope", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      companies: [
        { asiakasId: 1, name: "A" },
        { asiakasId: 2, name: "B" },
      ],
      currentCompanyId: 1,
    });
    const out = await runCompanyList(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/company-selection/available"
    );
    expect(out).toEqual({
      items: [
        { asiakasId: 1, name: "A", current: true },
        { asiakasId: 2, name: "B", current: false },
      ],
      nextCursor: null,
      count: 2,
    });
  });

  test("runCompanyCurrent: returns the active company record", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      companies: [
        { asiakasId: 1, name: "A" },
        { asiakasId: 2, name: "B" },
      ],
      currentCompanyId: 2,
    });
    const out = await runCompanyCurrent(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/company-selection/available"
    );
    expect(out).toEqual({ asiakasId: 2, name: "B" });
  });

  test("runCompanyCurrent: throws when no current company in response", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      companies: [{ asiakasId: 1, name: "A" }],
      currentCompanyId: 99,
    });
    await expect(runCompanyCurrent(mockClient)).rejects.toThrow(
      /No current company/
    );
  });
});
