import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runKeikkaIntakeResolve,
  runKeikkaIntakeCommit,
} from "../../src/commands/keikka/index.js";

const mockClient = mockApiClient();

describe("ib keikka intake resolve/commit", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("runKeikkaIntakeResolve POSTs to /api/cli/keikka/intake/resolve", async () => {
    mockClient.post.mockResolvedValueOnce({ orders: [] });
    const body = { orders: [] };
    const result = await runKeikkaIntakeResolve(mockClient, body, {});
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/intake/resolve",
      body,
      { headers: {} }
    );
    expect(result).toEqual({ orders: [] });
  });

  test("runKeikkaIntakeCommit POSTs to /api/cli/keikka/intake/commit and forwards write flags", async () => {
    mockClient.post.mockResolvedValueOnce({ keikkaId: 555, ref: "1" });
    const body = { order: {} };
    const result = await runKeikkaIntakeCommit(mockClient, body, {
      reason: "AI intake",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/intake/commit",
      body,
      { headers: { "X-Action-Reason": "AI intake" } }
    );
    expect((result as { keikkaId: number }).keikkaId).toBe(555);
  });
});
