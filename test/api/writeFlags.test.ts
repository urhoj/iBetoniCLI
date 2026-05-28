import { describe, test, expect } from "vitest";
import { writeFlagsToHeaders } from "../../src/api/writeFlags.js";

describe("writeFlagsToHeaders", () => {
  test("returns empty object when no flags are set", () => {
    expect(writeFlagsToHeaders({})).toEqual({});
  });

  test("dry-run alone yields only X-Dry-Run: 1", () => {
    expect(writeFlagsToHeaders({ dryRun: true })).toEqual({
      "X-Dry-Run": "1",
    });
  });

  test("all three flags yield all three headers", () => {
    expect(
      writeFlagsToHeaders({
        dryRun: true,
        idempotencyKey: "abc-123",
        reason: "manual fix per ticket #42",
      })
    ).toEqual({
      "X-Dry-Run": "1",
      "Idempotency-Key": "abc-123",
      "X-Action-Reason": "manual fix per ticket #42",
    });
  });
});
