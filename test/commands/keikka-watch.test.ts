import { describe, test, expect, vi } from "vitest";
import { runWatchSet, runWatchList } from "../../src/commands/keikka/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = (data: unknown = {}) =>
  ({
    get: vi.fn().mockResolvedValue(data),
    post: vi.fn(),
    put: vi.fn().mockResolvedValue(data),
    delete: vi.fn().mockResolvedValue(data),
    getCurrentToken: vi.fn(),
  }) as unknown as ApiClient & Record<"get" | "put" | "delete", ReturnType<typeof vi.fn>>;

describe("ib keikka watch (fb#2979)", () => {
  test("set PUTs, cancel DELETEs, and both forward --dry-run", async () => {
    const c = mockClient();
    await runWatchSet(c, 13254, true, { dryRun: true });
    expect(c.put).toHaveBeenCalledWith("/api/keikka-watch/13254", {}, { headers: expect.objectContaining({ "X-Dry-Run": "1" }) });
    await runWatchSet(c, 13254, false, {});
    expect(c.delete).toHaveBeenCalledWith("/api/keikka-watch/13254", expect.anything());
  });

  test("list wraps the rows in a list envelope and filters by --keikka", async () => {
    const c = mockClient([{ keikkaId: 13254, firedAt: null }]);
    expect(await runWatchList(c, 13254)).toEqual({ items: [{ keikkaId: 13254, firedAt: null }], count: 1, nextCursor: null });
    expect(c.get).toHaveBeenCalledWith("/api/keikka-watch?keikkaId=13254");
    expect((await runWatchList(mockClient(null))).items).toEqual([]);
  });
});
