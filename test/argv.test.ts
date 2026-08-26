import { describe, test, expect } from "vitest";
import { normalizeSingleDashLongFlags } from "../src/argv.js";

// fb#856: agents recurrently type long flags with a single dash ('-reason').
// `ib` registers no short options of its own, so every single-dash
// multi-character token is a long-flag typo and is rewritten to double-dash
// form before Commander parses.
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
});
