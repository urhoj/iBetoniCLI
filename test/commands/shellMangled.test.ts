import { describe, test, expect, vi } from "vitest";
import { warnIfShellMangled } from "../../src/commands/_shared/flags.js";

/**
 * fb#552 — PowerShell's backtick is its ESCAPE character, so unlike the
 * inner-double-quote split (loud: exit 4, "too many arguments") it is consumed
 * silently and the command SUCCEEDS. Measured against the built CLI rather than
 * assumed: `ib feedback create "the `resolve` key"` arrives as char codes
 * 13,101,115,111,108,118,101 — CR + "esolve". The backtick does NOT survive as a
 * backslash, which is what a first pass at this detector wrongly looked for; the
 * escape sequence is EXPANDED, injecting a control character mid-word. The
 * corrupted text then becomes the permanent record on a feedback resolution or
 * changelog entry nobody re-reads.
 *
 * The detector fires on text that is ALREADY damaged, so a false positive costs
 * one ignorable stderr line while a miss costs a corrupted record — but it must
 * not cry wolf either, or it gets ignored and the real case loses its one chance
 * to be noticed. These pin both halves of that trade.
 */
describe("warnIfShellMangled", () => {
  const warnFor = (values: Record<string, string | undefined>): string[] => {
    const warn = vi.fn();
    warnIfShellMangled(values, warn);
    return warn.mock.calls.map((c) => String(c[0]));
  };

  test("fires on the real signature — a lone CR mid-word, as `r produces", () => {
    const out = warnFor({ note: "the \resolve key is excluded" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/--note/);
    expect(out[0]).toMatch(/EATEN BACKTICK/);
    // Must carry the fix, not just the diagnosis.
    expect(out[0]).toMatch(/--from-json/);
  });

  test("fires on the other non-printable escapes (`0 `a `b `v `f)", () => {
    for (const ch of ["\u0000", "\u0007", "\u0008", "\u000B", "\u000C"]) {
      expect(warnFor({ note: `text${ch}more` })).toHaveLength(1);
    }
  });

  test("names every affected flag in one line, not one warning per flag", () => {
    const out = warnFor({ description: "a \resolve here", impact: "and \runother" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/--description/);
    expect(out[0]).toMatch(/--impact/);
  });

  test("stays silent on clean prose, backslashes included", () => {
    expect(warnFor({ note: "no backticks here at all" })).toHaveLength(0);
    // A literal backslash is NOT the signature — the first version of this
    // detector looked for exactly this and would never have fired on the real bug.
    expect(warnFor({ note: "a path like C:\\Users and a \\resolve token" })).toHaveLength(0);
  });

  test("stays silent on TAB and LF, which are legitimate in prose", () => {
    // `t and `n do mangle too, but a multi-line or tab-containing note is
    // ordinary, so flagging them would make the warning noise and get it ignored.
    expect(warnFor({ note: "line one\nline two" })).toHaveLength(0);
    expect(warnFor({ note: "col\tcol" })).toHaveLength(0);
  });

  test("stays silent on CRLF — a genuinely multi-line argv value has it", () => {
    expect(warnFor({ note: "line one\r\nline two" })).toHaveLength(0);
  });

  test("ignores absent and non-string values rather than throwing", () => {
    expect(warnFor({ note: undefined, body: undefined })).toHaveLength(0);
  });
});
