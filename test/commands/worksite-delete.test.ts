import { describe, test, expect, vi, beforeEach } from "vitest";
import { runWorksiteDelete } from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runWorksiteDelete", () => {
  beforeEach(() => { (mockClient.delete as ReturnType<typeof vi.fn>).mockReset(); });

  test("DELETEs /api/tyomaa/delete/<tyomaaId> with reason header", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 99 });
    const result = await runWorksiteDelete(mockClient, 99, { reason: "lifecycle cleanup" });
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/tyomaa/delete/99",
      { headers: { "X-Action-Reason": "lifecycle cleanup" } }
    );
    expect(result).toEqual({ deleted: 99 });
  });

  test("forwards --dry-run", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: true });
    await runWorksiteDelete(mockClient, 99, { reason: "test", dryRun: true });
    const call = (mockClient.delete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers["X-Dry-Run"]).toBe("1");
  });
});
