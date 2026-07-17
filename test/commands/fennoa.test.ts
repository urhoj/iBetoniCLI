import { describe, test, expect, vi, beforeEach } from "vitest";
import { runFennoaPurchases } from "../../src/commands/fennoa/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
  endpoint: "http://127.0.0.1:3000",
} as unknown as ApiClient;

const body = {
  invoices: [
    {
      id: 1136,
      supplierName: "Työllisyysrahasto",
      supplierBusinessId: "0202198-1",
      invoiceNumber: "5003508236",
      invoiceDate: "2026-07-17",
      dueDate: "2026-08-07",
      totalGross: 728.86,
      totalNet: 728.86,
      totalDue: 728.86,
      termsOfPayment: "21",
      onHold: false,
      isReceipt: false,
      approvalStatus: "Waiting for approval",
      paymentStatus: "unpaid",
    },
  ],
  summary: { count: 1, totalDue: 728.86, overdueCount: 0, overdueTotal: 0, oldestDueDate: "2026-08-07" },
  fetchedAt: "2026-07-17T12:00:00.000Z",
  asiakasId: 26,
  months: 6,
};

describe("ib fennoa purchases", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("defaults hit the route with no query params and project an envelope", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(body);
    const out = await runFennoaPurchases(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/admin/fennoa/purchase-invoices");
    expect(out.items).toHaveLength(1);
    expect(out.count).toBe(1);
    expect(out.nextCursor).toBeNull();
    expect(out.summary).toEqual(body.summary);
    expect(out.asiakasId).toBe(26);
    expect(out.cached).toBeUndefined();
  });

  test("--all/--months/--asiakas/--refresh map to open=0&months&asiakas&refresh=1", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...body, cached: true });
    const out = await runFennoaPurchases(mockClient, { all: true, months: 2, asiakas: 8, refresh: true });
    expect(mockClient.get).toHaveBeenCalledWith("/api/admin/fennoa/purchase-invoices?open=0&months=2&asiakas=8&refresh=1");
    expect(out.cached).toBe(true);
  });
});
