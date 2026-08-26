import { describe, test, expect } from "vitest";
import { normalizeSingleDashLongFlags } from "../src/argv.js";

// fb#856: agents recurrently type long flags with a single dash ('-reason').
// `ib` registers no short options of its own, so a FREE-STANDING single-dash
// multi-character token is overwhelmingly a long-flag typo and is rewritten to
// double-dash form before Commander parses. The two pinned "residual" tests at
// the bottom document the accepted edge cases where the rewrite changes a
// previously-working (if unusual) invocation — see src/argv.ts.
describe("normalizeSingleDashLongFlags", () => {
  test("rewrites a single-dash long flag to double-dash", () => {
    expect(normalizeSingleDashLongFlags(["-reason"])).toEqual(["--reason"]);
  });

  test("keeps an attached =value on the rewritten flag", () => {
    expect(normalizeSingleDashLongFlags(["-reason=test"])).toEqual(["--reason=test"]);
  });

  test("rewrites only the flag tokens, leaving positionals alone", () => {
    expect(
      normalizeSingleDashLongFlags(["jerry", "admin", "enable", "1431", "-reason", "test"])
    ).toEqual(["jerry", "admin", "enable", "1431", "--reason", "test"]);
  });

  test("leaves single-char tokens alone (commander's auto -h/-V)", () => {
    expect(normalizeSingleDashLongFlags(["-h", "-V"])).toEqual(["-h", "-V"]);
  });

  test("leaves negative numbers alone", () => {
    expect(normalizeSingleDashLongFlags(["-1", "-123", "-1.5"])).toEqual(["-1", "-123", "-1.5"]);
  });

  test("leaves double-dash tokens and bare values alone", () => {
    expect(
      normalizeSingleDashLongFlags(["--reason", "--", "plain", "-"])
    ).toEqual(["--reason", "--", "plain", "-"]);
  });

  test("stops rewriting after the bare -- terminator", () => {
    expect(
      normalizeSingleDashLongFlags(["add", "--", "-reason", "-title"]
    )).toEqual(["add", "--", "-reason", "-title"]);
  });

  // RESIDUAL 1 (pinned, accepted — src/argv.ts): the rewrite is position-blind,
  // so a `-word` that used to sit in a VALUE position is rewritten too. A
  // deliberate dash-led literal must use the equals form, which is untouched.
  test("residual: a value-position -word is still rewritten", () => {
    expect(normalizeSingleDashLongFlags(["--title", "-reason"])).toEqual(["--title", "--reason"]);
  });

  test("the equals form protects a dash-led literal value", () => {
    expect(normalizeSingleDashLongFlags(["--title=-reason"])).toEqual(["--title=-reason"]);
  });

  // RESIDUAL 2 (pinned, accepted): commander's combined-shorts expansion also
  // matches and becomes an unknown double-dash token.
  test("residual: combined shorts -hV become unknown --hV", () => {
    expect(normalizeSingleDashLongFlags(["-hV", "-Vh"])).toEqual(["--hV", "--Vh"]);
  });
});
