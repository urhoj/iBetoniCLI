import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runKeikkaBetoniMatka } from "../../src/commands/keikka/index.js";

const mockClient = mockApiClient();

describe("ib keikka betoni-matka", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("previews by default — as a READ, so it passes --read-only (fb#2410)", async () => {
    mockClient.post.mockResolvedValueOnce({ betoniMatkaM: 1 });
    const out = await runKeikkaBetoniMatka(mockClient, 5, { refresh: false });
    expect(out).toEqual({ betoniMatkaM: 1 });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/keikka/5/betoni-matka",
      { mode: "preview" },
      { headers: {}, read: true }
    );
  });

  test("--refresh writes and forwards the write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({});
    await runKeikkaBetoniMatka(mockClient, 5, {
      refresh: true,
      dryRun: true,
      idempotencyKey: "bm-5",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/keikka/5/betoni-matka",
      { mode: "refresh" },
      { headers: expect.objectContaining({ "X-Dry-Run": "1", "Idempotency-Key": "bm-5" }), read: false }
    );
  });
});
