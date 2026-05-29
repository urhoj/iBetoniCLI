import { describe, test, expect, vi, beforeEach } from "vitest";
import { runPersonCreate } from "../../src/commands/person/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runPersonCreate", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs /api/person/newPerson with body and write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ personId: 5351 });
    const body = { personFirstName: "Test", personLastName: "User", personEmail: "test@x.com" };
    await runPersonCreate(mockClient, body, { reason: "lifecycle", idempotencyKey: "k1" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/newPerson",
      body,
      { headers: { "X-Action-Reason": "lifecycle", "Idempotency-Key": "k1" } }
    );
  });
});
