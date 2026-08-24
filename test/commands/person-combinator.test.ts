import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPersonDuplicates,
  runPersonMerge,
} from "../../src/commands/person/index.js";
import { resolveCombinatorOwner } from "../../src/commands/_shared/combinator.js";

const mockClient = mockApiClient();

const asGet = () => mockClient.get;
const asPost = () => mockClient.post;

describe("runPersonDuplicates", () => {
  beforeEach(() => {
    asGet().mockReset();
  });

  test("GETs person-combinator/duplicates with ownerAsiakasId and projects { pairs } into the envelope", async () => {
    asGet().mockResolvedValueOnce({
      pairs: [
        { id1: 1, name1: "Matti Meikäläinen", id2: 2, name2: "Matti Meikäläinen", matchCode: "phone", matchValue: "401234567", confidence: "high" },
      ],
    });
    const result = await runPersonDuplicates(mockClient, 8);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/admin/person-combinator/duplicates?ownerAsiakasId=8"
    );
    expect(result).toEqual({
      items: [
        { id1: 1, name1: "Matti Meikäläinen", id2: 2, name2: "Matti Meikäläinen", matchCode: "phone", matchValue: "401234567", confidence: "high" },
      ],
      nextCursor: null,
      count: 1,
      truncated: false,
    });
  });

  test("tolerates a missing pairs array (empty envelope)", async () => {
    asGet().mockResolvedValueOnce({});
    const result = await runPersonDuplicates(mockClient, 8);
    expect(result).toEqual({ items: [], nextCursor: null, count: 0, truncated: false });
  });

  test("sets truncated=true when the 100-pair cap is hit", async () => {
    asGet().mockResolvedValueOnce({
      pairs: Array.from({ length: 100 }, (_, i) => ({
        id1: i, name1: null, id2: i + 1000, name2: null, matchCode: "full_name", matchValue: null, confidence: "medium",
      })),
    });
    const result = await runPersonDuplicates(mockClient, 8);
    expect(result.count).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe("runPersonMerge", () => {
  beforeEach(() => {
    asPost().mockReset();
  });

  test("real merge POSTs person-combinator/merge with mainPersonId/secondaryPersonId + X-Action-Reason header", async () => {
    asPost().mockResolvedValueOnce({ success: true });
    const result = await runPersonMerge(
      mockClient,
      { mainId: 6001, secondaryId: 6002, ownerAsiakasId: 8 },
      { reason: "dedupe" }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/admin/person-combinator/merge",
      { mainPersonId: 6001, secondaryPersonId: 6002, ownerAsiakasId: 8 },
      { headers: { "X-Action-Reason": "dedupe" } }
    );
    expect(result).toEqual({ success: true });
  });

  test("--dry-run POSTs /validate (NOT /merge), tagged `read`, and wraps the result", async () => {
    asPost().mockResolvedValueOnce({ success: true, referencesToMove: 3 });
    const result = await runPersonMerge(
      mockClient,
      { mainId: 6001, secondaryId: 6002, ownerAsiakasId: 8 },
      { dryRun: true, reason: "ignored on validate" }
    );
    expect(asPost().mock.calls).toHaveLength(1);
    expect(asPost().mock.calls[0][0]).toBe("/api/admin/person-combinator/validate");
    expect(asPost().mock.calls[0][1]).toEqual({ mainPersonId: 6001, secondaryPersonId: 6002, ownerAsiakasId: 8 });
    // Tagged `read` so it runs under --read-only and skips the acting-as write diagnostic.
    expect(asPost().mock.calls[0][2]).toEqual({ read: true });
    expect(result).toEqual({ dryRun: true, validation: { success: true, referencesToMove: 3 } });
  });

  // fb#849: the unowned class (ownerAsiakasId 0) must survive to the wire —
  // a `0 || fallback` anywhere on the path would silently retarget the merge.
  test("ownerAsiakasId 0 (the unowned class) is sent verbatim", async () => {
    asPost().mockResolvedValueOnce({ success: true });
    await runPersonMerge(
      mockClient,
      { mainId: 10, secondaryId: 27, ownerAsiakasId: 0 },
      { dryRun: true }
    );
    expect(asPost().mock.calls[0][1]).toEqual({ mainPersonId: 10, secondaryPersonId: 27, ownerAsiakasId: 0 });
  });
});

// fb#849: --unowned → owner 0; --owner wins otherwise; both together exit 4
// (silently preferring one would target the wrong tenant on an IRREVERSIBLE op).
describe("resolveCombinatorOwner", () => {
  test("--unowned resolves to 0 without touching the client", async () => {
    await expect(resolveCombinatorOwner(mockClient, { unowned: true })).resolves.toBe(0);
  });

  test("--owner passes through", async () => {
    await expect(resolveCombinatorOwner(mockClient, { owner: 1349 })).resolves.toBe(1349);
  });

  test("--unowned with --owner exits 4", async () => {
    await expect(
      resolveCombinatorOwner(mockClient, { unowned: true, owner: 8 })
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});
