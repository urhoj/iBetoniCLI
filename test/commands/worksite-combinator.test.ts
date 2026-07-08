import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runWorksiteDuplicates,
  runWorksiteMerge,
} from "../../src/commands/worksite/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const asGet = () => mockClient.get as ReturnType<typeof vi.fn>;
const asPost = () => mockClient.post as ReturnType<typeof vi.fn>;

describe("runWorksiteDuplicates", () => {
  beforeEach(() => {
    asGet().mockReset();
  });

  test("GETs tyomaa-combinator/duplicates with ownerAsiakasId and projects { pairs } into the envelope", async () => {
    asGet().mockResolvedValueOnce({
      pairs: [
        { id1: 701, name1: "Kohde A", id2: 702, name2: "Kohde A", matchCode: "tyomaa_strict", matchValue: null, confidence: "high" },
      ],
    });
    const result = await runWorksiteDuplicates(mockClient, 8);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/admin/tyomaa-combinator/duplicates?ownerAsiakasId=8"
    );
    expect(result).toEqual({
      items: [
        { id1: 701, name1: "Kohde A", id2: 702, name2: "Kohde A", matchCode: "tyomaa_strict", matchValue: null, confidence: "high" },
      ],
      nextCursor: null,
      count: 1,
      truncated: false,
    });
  });

  test("tolerates a missing pairs array (empty envelope)", async () => {
    asGet().mockResolvedValueOnce({});
    const result = await runWorksiteDuplicates(mockClient, 8);
    expect(result).toEqual({ items: [], nextCursor: null, count: 0, truncated: false });
  });

  test("sets truncated=true when the 100-pair cap is hit", async () => {
    asGet().mockResolvedValueOnce({
      pairs: Array.from({ length: 100 }, (_, i) => ({
        id1: i, name1: null, id2: i + 1000, name2: null, matchCode: "tyomaa_anonymous", matchValue: null, confidence: "medium",
      })),
    });
    const result = await runWorksiteDuplicates(mockClient, 8);
    expect(result.count).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe("runWorksiteMerge", () => {
  beforeEach(() => {
    asPost().mockReset();
  });

  test("real merge POSTs tyomaa-combinator/merge with mainTyomaaId/secondaryTyomaaId + X-Action-Reason header", async () => {
    asPost().mockResolvedValueOnce({ success: true });
    const result = await runWorksiteMerge(
      mockClient,
      { mainId: 701, secondaryId: 702, ownerAsiakasId: 8 },
      { reason: "dedupe" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/admin/tyomaa-combinator/merge",
      { mainTyomaaId: 701, secondaryTyomaaId: 702, ownerAsiakasId: 8 },
      { headers: { "X-Action-Reason": "dedupe" } }
    );
    expect(result).toEqual({ success: true });
  });

  test("--dry-run POSTs /validate (NOT /merge), tagged `read`, and wraps the result", async () => {
    asPost().mockResolvedValueOnce({ success: true, referencesToMove: 5 });
    const result = await runWorksiteMerge(
      mockClient,
      { mainId: 701, secondaryId: 702, ownerAsiakasId: 8 },
      { dryRun: true, reason: "ignored on validate" }
    );
    expect(asPost().mock.calls).toHaveLength(1);
    expect(asPost().mock.calls[0][0]).toBe("/api/admin/tyomaa-combinator/validate");
    expect(asPost().mock.calls[0][1]).toEqual({ mainTyomaaId: 701, secondaryTyomaaId: 702, ownerAsiakasId: 8 });
    // Tagged `read` so it runs under --read-only and skips the acting-as write diagnostic.
    expect(asPost().mock.calls[0][2]).toEqual({ read: true });
    expect(result).toEqual({ dryRun: true, validation: { success: true, referencesToMove: 5 } });
  });
});
