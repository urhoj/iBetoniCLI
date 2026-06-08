import { describe, test, expect, vi } from "vitest";
import { runKeikkaUpdate } from "../../src/commands/keikka/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib keikka update validation", () => {
  test("runKeikkaUpdate throws when no status field is present", async () => {
    await expect(
      runKeikkaUpdate(mockClient, 5, {}, {})
    ).rejects.toThrow(/only supports --status/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });
});
