import { describe, test, expect } from "vitest";
import { diffFields } from "../src/diff.js";

describe("diffFields", () => {
  test("reports only changed fields with raw from/to", () => {
    const current = { a: 1, b: "x", c: true };
    const next = { a: 2, b: "x", c: false };
    expect(diffFields(current, next, ["a", "b", "c"])).toEqual({
      a: { from: 1, to: 2 },
      c: { from: true, to: false },
    });
  });

  test("string '28' does not read as a change vs numeric 28", () => {
    expect(diffFields({ m3: 28 }, { m3: "28" }, ["m3"])).toEqual({});
  });

  test("null / undefined / '' all normalize to unset (no spurious change)", () => {
    expect(diffFields({ a: null, b: undefined, c: "" }, { a: undefined, b: "", c: null }, ["a", "b", "c"])).toEqual({});
  });

  test("setting an unset field is a change (null -> value)", () => {
    expect(diffFields({ d: null }, { d: "2026-12-31" }, ["d"])).toEqual({
      d: { from: null, to: "2026-12-31" },
    });
  });

  test("only the listed fields are considered", () => {
    const current = { a: 1, ignored: "old" };
    const next = { a: 1, ignored: "new" };
    expect(diffFields(current, next, ["a"])).toEqual({});
  });

  test("from/to coalesce undefined to null in the output", () => {
    expect(diffFields({ a: undefined }, { a: 5 }, ["a"])).toEqual({
      a: { from: null, to: 5 },
    });
  });
});
