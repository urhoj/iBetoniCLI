import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runWorksiteDelete } from "../../src/commands/worksite/index.js";

const mockClient = mockApiClient();

describe("runWorksiteDelete", () => {
  beforeEach(() => { mockClient.delete.mockReset(); });

  test("DELETEs /api/tyomaa/delete/<tyomaaId> with reason header", async () => {
    mockClient.delete.mockResolvedValueOnce({ deleted: 99 });
    const result = await runWorksiteDelete(mockClient, 99, { reason: "lifecycle cleanup" });
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/tyomaa/delete/99",
      { headers: { "X-Action-Reason": "lifecycle cleanup" } }
    );
    expect(result).toEqual({ deleted: 99 });
  });

  test("forwards --dry-run", async () => {
    mockClient.delete.mockResolvedValueOnce({ dryRun: true });
    await runWorksiteDelete(mockClient, 99, { reason: "test", dryRun: true });
    const call = mockClient.delete.mock.calls[0];
    expect(call[1].headers["X-Dry-Run"]).toBe("1");
  });
});
