import { describe, test, expect, vi, beforeEach } from "vitest";
import { runCustomerPersonAdd } from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runCustomerPersonAdd", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("POSTs /api/asiakas/person/add with body and reason header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runCustomerPersonAdd(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test add" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/person/add",
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "test add" } }
    );
  });

  test("forwards --dry-run header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: true });
    await runCustomerPersonAdd(
      mockClient,
      { asiakasId: 26, personId: 5351, contactPersonTypeId: 1 },
      { reason: "test", dryRun: true }
    );
    const call = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2].headers["X-Dry-Run"]).toBe("1");
  });
});
