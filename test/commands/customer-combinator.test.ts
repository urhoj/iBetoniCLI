import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runCustomerDuplicates,
  runCustomerMerge,
} from "../../src/commands/customer/index.js";

const mockClient = mockApiClient();

const asGet = () => mockClient.get;
const asPost = () => mockClient.post;

describe("runCustomerDuplicates", () => {
  beforeEach(() => {
    asGet().mockReset();
  });

  test("GETs /duplicates with ownerAsiakasId and projects { pairs } into the envelope", async () => {
    asGet().mockResolvedValueOnce({
      pairs: [
        { id1: 1, name1: "A Oy", id2: 2, name2: "A Oy", matchCode: "ytunnus", matchValue: "123", confidence: "high" },
      ],
    });
    const result = await runCustomerDuplicates(mockClient, 8);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/admin/asiakas-combinator/duplicates?ownerAsiakasId=8"
    );
    expect(result).toEqual({
      items: [
        { id1: 1, name1: "A Oy", id2: 2, name2: "A Oy", matchCode: "ytunnus", matchValue: "123", confidence: "high" },
      ],
      nextCursor: null,
      count: 1,
      truncated: false,
    });
  });

  test("tolerates a missing pairs array (empty envelope)", async () => {
    asGet().mockResolvedValueOnce({});
    const result = await runCustomerDuplicates(mockClient, 8);
    expect(result).toEqual({ items: [], nextCursor: null, count: 0, truncated: false });
  });

  test("sets truncated=true when the 100-pair cap is hit", async () => {
    asGet().mockResolvedValueOnce({
      pairs: Array.from({ length: 100 }, (_, i) => ({
        id1: i, name1: null, id2: i + 1000, name2: null, matchCode: "name_prefix", matchValue: null, confidence: "low",
      })),
    });
    const result = await runCustomerDuplicates(mockClient, 8);
    expect(result.count).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe("runCustomerMerge", () => {
  beforeEach(() => {
    asPost().mockReset();
  });

  test("real merge POSTs /merge with the body + X-Action-Reason header", async () => {
    asPost().mockResolvedValueOnce({ success: true });
    const result = await runCustomerMerge(
      mockClient,
      { mainId: 8001, secondaryId: 8002, ownerAsiakasId: 8 },
      { reason: "dedupe" }
    );
    // The WIRE body keeps the asiakas-specific field names — that is the point
    // of CombinatorIdFields, and the proof this migration changed no payload.
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/admin/asiakas-combinator/merge",
      { mainAsiakasId: 8001, secondaryAsiakasId: 8002, ownerAsiakasId: 8 },
      { headers: { "X-Action-Reason": "dedupe" } }
    );
    expect(result).toEqual({ success: true });
  });

  test("--dry-run POSTs /validate (NOT /merge) and wraps the result", async () => {
    asPost().mockResolvedValueOnce({ success: true, referencesToMove: 3 });
    const result = await runCustomerMerge(
      mockClient,
      { mainId: 8001, secondaryId: 8002, ownerAsiakasId: 8 },
      { dryRun: true, reason: "ignored on validate" }
    );
    expect(mockClient.post).toHaveBeenCalledTimes(1);
    expect(asPost().mock.calls[0][0]).toBe("/api/admin/asiakas-combinator/validate");
    // Tagged `read` so it runs under --read-only and skips the acting-as write diagnostic.
    expect(asPost().mock.calls[0][2]).toEqual({ read: true });
    expect(result).toEqual({ dryRun: true, validation: { success: true, referencesToMove: 3 } });
  });

  test("forwards allowBigMerge only when set", async () => {
    asPost().mockResolvedValueOnce({ success: true });
    await runCustomerMerge(
      mockClient,
      { mainId: 1, secondaryId: 2, ownerAsiakasId: 8, allowBigMerge: true },
      { reason: "big" }
    );
    expect(asPost().mock.calls[0][1]).toMatchObject({ allowBigMerge: true });
  });
});
