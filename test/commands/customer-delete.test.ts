import { describe, test, expect, vi, beforeEach } from "vitest";
import { runCustomerDelete } from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runCustomerDelete", () => {
  beforeEach(() => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockReset();
  });

  test("DELETEs /api/asiakas/delete/<asiakasId>/<ownerAsiakasId> with X-Action-Reason", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 9001 });
    const result = await runCustomerDelete(
      mockClient,
      9001,
      1349,
      { reason: "lifecycle cleanup" }
    );
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/asiakas/delete/9001/1349",
      { headers: { "X-Action-Reason": "lifecycle cleanup" } }
    );
    expect(result).toEqual({ deleted: 9001 });
  });

  test("propagates --dry-run as X-Dry-Run: 1 header", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: true, wouldDelete: 9001 });
    await runCustomerDelete(mockClient, 9001, 1349, { reason: "test", dryRun: true });
    const call = (mockClient.delete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers).toMatchObject({
      "X-Action-Reason": "test",
      "X-Dry-Run": "1",
    });
  });
});
