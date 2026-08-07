import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runCompanyList,
  runCompanyCurrent,
} from "../../src/commands/company/index.js";

const mockClient = mockApiClient();

describe("ib company", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("runCompanyList: GETs /api/company-selection/available and projects envelope", async () => {
    mockClient.get.mockResolvedValueOnce({
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
    mockClient.get.mockResolvedValueOnce({
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
    mockClient.get.mockResolvedValueOnce({
      companies: [{ asiakasId: 1, name: "A" }],
      currentCompanyId: 99,
    });
    await expect(runCompanyCurrent(mockClient)).rejects.toThrow(
      /No current company/
    );
  });
});
