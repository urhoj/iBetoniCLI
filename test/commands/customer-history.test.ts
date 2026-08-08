import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runCustomerHistory } from "../../src/commands/customer/index.js";

const mockClient = mockApiClient();
const get = () => mockClient.get;

describe("runCustomerHistory", () => {
  beforeEach(() => get().mockReset());

  test("resolves owner, queries /api/changes/asiakas, projects the raw array", async () => {
    get()
      .mockResolvedValueOnce({ currentCompanyId: 1349 })
      .mockResolvedValueOnce([
        {
          changeId: 11, fieldName: "asiakasNimi", oldValue: "A", newValue: "B",
          changeType: "info_change", personId: 6233, personFullName: "Matti M",
          timestamp: "2026-06-01T10:00:00.000Z", description: "Nimi: A → B",
          reason: "asiakas request",
        },
      ]);
    const result = await runCustomerHistory(mockClient, 26, 50);
    expect(get()).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
    expect(get()).toHaveBeenNthCalledWith(2, "/api/changes/asiakas/26/1349?limit=50");
    expect(result).toEqual({
      items: [
        {
          changeId: 11, field: "asiakasNimi", oldValue: "A", newValue: "B",
          changeType: "info_change", personId: 6233, personName: "Matti M",
          at: "2026-06-01T10:00:00.000Z", description: "Nimi: A → B",
          reason: "asiakas request",
        },
      ],
      nextCursor: null,
      count: 1,
    });
  });

  test("a full server page sets truncated (no cursor — the only more-rows signal)", async () => {
    get()
      .mockResolvedValueOnce({ currentCompanyId: 1349 })
      .mockResolvedValueOnce([
        { changeId: 11, fieldName: "asiakasNimi" },
        { changeId: 12, fieldName: "asiakasNimi" },
      ]);
    const result = await runCustomerHistory(mockClient, 26, 2);
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(2);
  });
});
