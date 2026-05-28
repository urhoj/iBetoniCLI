import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiCreate,
  runSijaintiUpdate,
} from "../../src/commands/sijainti/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib sijainti create/update", () => {
  beforeEach(() => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runSijaintiCreate forwards body + all three write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 4242,
    });
    const body = {
      sijaintiNimi: "Helsinki HQ",
      sijaintiOsoite1: "Mannerheimintie 1",
      lat: 60.17,
      lng: 24.94,
    };
    const result = await runSijaintiCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-helsinki-hq",
      reason: "office relocation",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/geocode/sijainti/add",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "create-helsinki-hq",
          "X-Action-Reason": "office relocation",
        },
      }
    );
    expect((result as { sijaintiId: number }).sijaintiId).toBe(4242);
  });

  test("runSijaintiUpdate posts to /api/geocode/updateSijainti with sijaintiId IN body (not URL) + flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });
    const body = { sijaintiId: 4242, sijaintiNimi: "Helsinki HQ — Tower B" };
    await runSijaintiUpdate(mockClient, body, {
      reason: "tower split",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/geocode/updateSijainti",
      body,
      { headers: { "X-Action-Reason": "tower split" } }
    );
  });
});
