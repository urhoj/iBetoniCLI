import { describe, test, expect, vi, beforeEach } from "vitest";
import { runCustomerHistory } from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const get = () => mockClient.get as ReturnType<typeof vi.fn>;

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
        },
      ],
      nextCursor: null,
      count: 1,
    });
  });
});
