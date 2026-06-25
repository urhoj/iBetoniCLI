import { describe, test, expect } from "vitest";
import { applyTextEdit, parseEditOp } from "../src/textEdit.js";

describe("applyTextEdit — replace (strict match)", () => {
  test("exactly one match → substitutes and reports matchCount", () => {
    expect(applyTextEdit("a 14 vrk b", { kind: "replace", find: "14 vrk", replacement: "30 vrk" }))
      .toEqual({ next: "a 30 vrk b", matchCount: 1 });
  });

  test("zero matches → exit 4 (not found)", () => {
    expect(() => applyTextEdit("abc", { kind: "replace", find: "xyz", replacement: "q" }))
      .toThrow(/not found/i);
  });

  test("multiple matches without --all → exit 4 (matched N times)", () => {
    expect(() => applyTextEdit("x x x", { kind: "replace", find: "x", replacement: "y" }))
      .toThrow(/matched 3 times/i);
  });

  test("multiple matches with all:true → replaces every occurrence", () => {
    expect(applyTextEdit("x x x", { kind: "replace", find: "x", replacement: "y", all: true }))
      .toEqual({ next: "y y y", matchCount: 3 });
  });

  test("empty replacement deletes the matched text", () => {
    expect(applyTextEdit("keep [drop]", { kind: "replace", find: " [drop]", replacement: "" }))
      .toEqual({ next: "keep", matchCount: 1 });
  });

  test("empty find is treated as not found (exit 4)", () => {
    expect(() => applyTextEdit("abc", { kind: "replace", find: "", replacement: "z" }))
      .toThrow(/not found/i);
  });
});

describe("applyTextEdit — append / prepend (verbatim)", () => {
  test("append concatenates with no separator", () => {
    expect(applyTextEdit("body", { kind: "append", text: "\nmore" })).toEqual({ next: "body\nmore" });
  });
  test("prepend concatenates with no separator", () => {
    expect(applyTextEdit("body", { kind: "prepend", text: "intro\n" })).toEqual({ next: "intro\nbody" });
  });
  test("append onto empty/undefined current", () => {
    expect(applyTextEdit("", { kind: "append", text: "x" })).toEqual({ next: "x" });
  });
});

describe("parseEditOp", () => {
  test("no edit flags → undefined (caller uses whole-body path)", () => {
    expect(parseEditOp({})).toBeUndefined();
  });
  test("--replace + --with → replace op", () => {
    expect(parseEditOp({ replace: "a", with: "b" })).toEqual({ kind: "replace", find: "a", replacement: "b", all: false });
  });
  test("--replace + --with + --all → all:true", () => {
    expect(parseEditOp({ replace: "a", with: "b", all: true })).toEqual({ kind: "replace", find: "a", replacement: "b", all: true });
  });
  test("--replace without --with → exit 4", () => {
    expect(() => parseEditOp({ replace: "a" })).toThrow(/--replace requires --with/i);
  });
  test("--with without --replace → exit 4", () => {
    expect(() => parseEditOp({ with: "b" })).toThrow(/--with requires --replace/i);
  });
  test("--all without --replace → exit 4", () => {
    expect(() => parseEditOp({ append: "x", all: true })).toThrow(/--all only applies/i);
  });
  test("--append → append op", () => {
    expect(parseEditOp({ append: "x" })).toEqual({ kind: "append", text: "x" });
  });
  test("--prepend → prepend op", () => {
    expect(parseEditOp({ prepend: "x" })).toEqual({ kind: "prepend", text: "x" });
  });
  test("two edit kinds at once → exit 4", () => {
    expect(() => parseEditOp({ append: "x", prepend: "y" })).toThrow(/only one of/i);
  });
  test("empty-string edit value is still an op (not undefined)", () => {
    expect(parseEditOp({ append: "" })).toEqual({ kind: "append", text: "" });
  });
});
