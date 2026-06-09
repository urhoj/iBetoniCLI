import { describe, test, expect } from "vitest";
import { runHelpList, runHelpTopic } from "../../src/commands/help/index.js";

describe("ib help topics", () => {
  test("list returns topic ids", () => {
    const r = runHelpList();
    expect(r.items.map((t) => t.id)).toContain("roles");
    expect(r.count).toBe(r.items.length);
  });
  test("get returns one topic body", () => {
    const t = runHelpTopic("write-safety");
    expect(t.id).toBe("write-safety");
    expect(t.body.length).toBeGreaterThan(20);
  });
  test("unknown topic throws (mapped to exit 5)", () => {
    expect(() => runHelpTopic("nope")).toThrowError(/unknown topic/i);
  });
});
