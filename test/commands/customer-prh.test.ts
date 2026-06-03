import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runCustomerPrhById,
  runCustomerPrhSearch,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const get = () => mockClient.get as ReturnType<typeof vi.fn>;

describe("runCustomerPrhById", () => {
  beforeEach(() => get().mockReset());

  test("unwraps .data from the PRH single-company envelope", async () => {
    get().mockResolvedValue({
      success: true,
      data: {
        businessId: "0145937-9",
        name: "Example Oy",
        tradeNames: ["ExOy"],
        address: { street: "Main St 1", postCode: "00100", city: "Helsinki", full: "Main St 1, 00100 Helsinki" },
        companyForm: { type: "OY", name: "Osakeyhtiö" },
        status: "active",
      },
      timestamp: "2026-06-02T00:00:00.000Z",
    });
    const result = await runCustomerPrhById(mockClient, "0145937-9");
    expect(get()).toHaveBeenCalledWith("/api/prh/company/0145937-9");
    expect(result.name).toBe("Example Oy");
    expect(result.address?.city).toBe("Helsinki");
  });
});

describe("runCustomerPrhSearch", () => {
  beforeEach(() => get().mockReset());

  test("projects .data.companies into a ListEnvelope", async () => {
    get().mockResolvedValue({
      success: true,
      data: {
        totalResults: 2,
        currentPage: 1,
        companies: [
          { businessId: "1", name: "Acme Oy", address: { city: "Espoo" } },
          { businessId: "2", name: "Beta Ab", address: null },
        ],
      },
    });
    const result = await runCustomerPrhSearch(mockClient, "ac", 1);
    expect(get()).toHaveBeenCalledWith("/api/prh/search/name?q=ac&page=1");
    expect(result).toEqual({
      items: [
        { businessId: "1", name: "Acme Oy", city: "Espoo" },
        { businessId: "2", name: "Beta Ab", city: null },
      ],
      nextCursor: null,
      count: 2,
    });
  });

  test("returns an empty envelope when no companies match", async () => {
    get().mockResolvedValue({ success: true, data: { totalResults: 0, companies: [] } });
    const result = await runCustomerPrhSearch(mockClient, "zzz", 1);
    expect(result).toEqual({ items: [], nextCursor: null, count: 0 });
  });
});
