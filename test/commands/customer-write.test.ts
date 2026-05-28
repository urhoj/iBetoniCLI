import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runCustomerCreate,
  runCustomerUpdate,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib customer create/update", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runCustomerCreate forwards body + all three write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      asiakasId: 9999,
    });
    const body = { asiakasNimi: "Acme Oy", ytunnus: "1234567-8" };
    const result = await runCustomerCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-acme-2026-05-28",
      reason: "imported from external CRM",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/createY",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "create-acme-2026-05-28",
          "X-Action-Reason": "imported from external CRM",
        },
      }
    );
    expect((result as { asiakasId: number }).asiakasId).toBe(9999);
  });

  test("runCustomerUpdate posts to /api/asiakas/set/:asiakasId with body + flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    const body = { asiakasNimi: "Acme Group Oy" };
    await runCustomerUpdate(mockClient, 9999, body, {
      reason: "renamed after acquisition",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakas/set/9999",
      body,
      {
        headers: { "X-Action-Reason": "renamed after acquisition" },
      }
    );
  });
});
