import { describe, test, expect, vi, beforeEach } from "vitest";
import { runWorksitePersonAdd } from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runWorksitePersonAdd", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs /api/tyomaa/person/add with body and reason header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runWorksitePersonAdd(
      mockClient,
      { tyomaaId: 99, personId: 5351, contactPersonTypeId: 1 },
      { reason: "lifecycle add" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/tyomaa/person/add",
      { tyomaaId: 99, personId: 5351, contactPersonTypeId: 1 },
      { headers: { "X-Action-Reason": "lifecycle add" } }
    );
  });
});
