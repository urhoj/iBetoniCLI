import { describe, test, expect } from "vitest";
import { Command } from "commander";
import {
  addOwnerOption,
  assertEnum,
  numFlag,
  parseId,
  parseOptionalId,
  parseRefId,
  resolveDateInput,
  resolveSearchQuery,
  zeroOneFlag,
} from "../src/targets.js";
import { todayHelsinki } from "../src/dates.js";

/** Run fn and return the CliError exitCode it threw (or undefined if it didn't throw). */
const exitCodeOf = (fn: () => void): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
};

/** Run fn and return the CliError it threw (or undefined if it didn't throw). */
const errorOf = (
  fn: () => void
): { exitCode?: number; message?: string; hint?: string; body?: unknown } | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as { exitCode?: number; message?: string; hint?: string; body?: unknown };
  }
};

describe("parseId", () => {
  test("accepts a canonical positive integer (and trims surrounding space)", () => {
    expect(parseId("53", "keikkaId")).toBe(53);
    expect(parseId(" 1349 ", "asiakasId")).toBe(1349);
  });

  test("rejects every non-positive-integer form with exit 4", () => {
    for (const bad of ["abc", "", "  ", "0", "-3", "5.5", "1e3", "0x10", "12abc", "NaN"]) {
      expect(exitCodeOf(() => parseId(bad, "id"))).toBe(4);
    }
  });

  test("error names the field and echoes the offending value", () => {
    expect(() => parseId("abc", "keikkaId")).toThrow(/invalid keikkaId: "abc"/);
  });
});

describe("parseOptionalId", () => {
  test("undefined in → undefined out (the no-id-given case)", () => {
    expect(parseOptionalId(undefined, "personId")).toBeUndefined();
  });

  test("delegates to parseId for a provided value", () => {
    expect(parseOptionalId("7", "personId")).toBe(7);
    expect(exitCodeOf(() => parseOptionalId("nope", "personId"))).toBe(4);
  });
});

describe("parseRefId (feedback #230 fb#/cl# anchor)", () => {
  test("a bare number passes through unchanged (both types)", () => {
    expect(parseRefId("230", "feedback", "get")).toBe(230);
    expect(parseRefId(" 858 ", "changelog", "get")).toBe(858);
  });

  test("a MATCHING prefix is stripped — every accepted spelling/separator/case", () => {
    for (const s of ["fb#230", "fb230", "fb-230", "fb:230", "fb_230", "FB#230", "f#230", "f230"]) {
      expect(parseRefId(s, "feedback", "get")).toBe(230);
    }
    for (const s of ["cl#858", "cl858", "CL-858", "c:858", "c858"]) {
      expect(parseRefId(s, "changelog", "get")).toBe(858);
    }
  });

  test("a WRONG-type prefix → exit 4, code WRONG_REF_TYPE, corrective command in the hint", () => {
    const e = errorOf(() => parseRefId("cl#858", "feedback", "get"));
    expect(e?.exitCode).toBe(4);
    expect((e?.body as { code?: string })?.code).toBe("WRONG_REF_TYPE");
    expect(e?.message).toMatch(/cl#858 is a changelog id, not a feedback id/);
    expect(e?.hint).toBe("run: ib dev changelog get 858");

    const e2 = errorOf(() => parseRefId("fb#230", "changelog", "get"));
    expect(e2?.exitCode).toBe(4);
    expect(e2?.hint).toBe("run: ib dev feedback get 230");
  });

  test("the corrective hint mirrors the verb when the other tree has it, else falls back to get", () => {
    // changelog HAS update → mirror it
    expect(errorOf(() => parseRefId("cl#858", "feedback", "update"))?.hint).toBe(
      "run: ib dev changelog update 858"
    );
    // changelog has NO resolve → fall back to get
    expect(errorOf(() => parseRefId("cl#858", "feedback", "resolve"))?.hint).toBe(
      "run: ib dev changelog get 858"
    );
    // feedback has NO delete → fall back to get
    expect(errorOf(() => parseRefId("fb#230", "changelog", "delete"))?.hint).toBe(
      "run: ib dev feedback get 230"
    );
    // feedback HAS update → mirror it
    expect(errorOf(() => parseRefId("fb#230", "changelog", "update"))?.hint).toBe(
      "run: ib dev feedback update 230"
    );
  });

  test("a matching prefix on a non-positive id is still rejected by parseId (exit 4, not WRONG_REF_TYPE)", () => {
    const e = errorOf(() => parseRefId("fb#0", "feedback", "get"));
    expect(e?.exitCode).toBe(4);
    expect((e?.body as { code?: string })?.code).toBeUndefined();
  });

  test("an unknown letter prefix or garbage falls to parseId's canonical-integer guard (exit 4)", () => {
    for (const bad of ["x230", "abc", "5.5", "230abc", "0x10"]) {
      expect(exitCodeOf(() => parseRefId(bad, "feedback", "get"))).toBe(4);
    }
  });
});

describe("resolveSearchQuery (feedback #235 — positional OR --search)", () => {
  test("positional alone resolves (trimmed)", () => {
    expect(resolveSearchQuery("Puminet", undefined)).toBe("Puminet");
    expect(resolveSearchQuery("  Betoni Oy  ", undefined)).toBe("Betoni Oy");
  });

  test("--search flag alone resolves (the fb#235 case)", () => {
    expect(resolveSearchQuery(undefined, "Puminet")).toBe("Puminet");
  });

  test("both allowed when they agree (after trim)", () => {
    expect(resolveSearchQuery("Puminet", " Puminet ")).toBe("Puminet");
  });

  test("both differ → exit 4", () => {
    expect(exitCodeOf(() => resolveSearchQuery("Puminet", "Betoni"))).toBe(4);
  });

  test("neither (or whitespace-only) → exit 4", () => {
    expect(exitCodeOf(() => resolveSearchQuery(undefined, undefined))).toBe(4);
    expect(exitCodeOf(() => resolveSearchQuery("   ", undefined))).toBe(4);
    expect(exitCodeOf(() => resolveSearchQuery(undefined, "  "))).toBe(4);
  });

  test("missing-query error names both input forms", () => {
    expect(() => resolveSearchQuery(undefined, undefined)).toThrow(/<query>.*--search/);
  });

  describe("--query alias of --search (fb#740)", () => {
    test("--query alone resolves like --search", () => {
      expect(resolveSearchQuery(undefined, undefined, "FPA-837")).toBe("FPA-837");
      expect(resolveSearchQuery(undefined, undefined, "  FPA-837  ")).toBe("FPA-837");
    });

    test("positional + --query agree → resolves", () => {
      expect(resolveSearchQuery("FPA-837", undefined, " FPA-837 ")).toBe("FPA-837");
    });

    test("--search and --query agree → resolves", () => {
      expect(resolveSearchQuery(undefined, "FPA-837", " FPA-837 ")).toBe("FPA-837");
    });

    test("--search and --query differ → exit 4", () => {
      expect(exitCodeOf(() => resolveSearchQuery(undefined, "FPA-837", "REK-123"))).toBe(4);
    });

    test("empty/whitespace --query falls back to --search or positional", () => {
      expect(resolveSearchQuery(undefined, "FPA-837", "   ")).toBe("FPA-837");
      expect(resolveSearchQuery("FPA-837", undefined, "")).toBe("FPA-837");
    });

    test("--query alone, whitespace-only → exit 4", () => {
      expect(exitCodeOf(() => resolveSearchQuery(undefined, undefined, "   "))).toBe(4);
    });
  });
});

describe("resolveDateInput (feedback #393 — positional OR --date)", () => {
  test("positional alone resolves, with aliases expanded", () => {
    expect(resolveDateInput("2026-06-10", undefined)).toBe("2026-06-10");
    expect(resolveDateInput("today", undefined)).toBe(todayHelsinki());
  });

  test("--date flag alone resolves (the fb#393 case)", () => {
    expect(resolveDateInput(undefined, "2026-06-10")).toBe("2026-06-10");
    expect(resolveDateInput(undefined, "today")).toBe(todayHelsinki());
  });

  test("both allowed when they mean the same day AFTER alias expansion", () => {
    // The comparison has to happen post-expansion: `today` and its ISO
    // spelling are one day, and rejecting that pair as a conflict would be a
    // false positive on the most natural way to write the same thing twice.
    expect(resolveDateInput("today", todayHelsinki())).toBe(todayHelsinki());
    expect(resolveDateInput("2026-06-10", "2026-06-10")).toBe("2026-06-10");
  });

  test("both, meaning different days → exit 4", () => {
    expect(exitCodeOf(() => resolveDateInput("2026-06-10", "2026-06-11"))).toBe(4);
    expect(exitCodeOf(() => resolveDateInput("today", "tomorrow"))).toBe(4);
  });

  test("neither → exit 4, naming both input forms", () => {
    expect(exitCodeOf(() => resolveDateInput(undefined, undefined))).toBe(4);
    expect(() => resolveDateInput(undefined, undefined)).toThrow(/<date>.*--date/);
  });

  test("an unrecognised string passes through for the backend to reject", () => {
    // Same contract as resolveDate: only the three aliases are expanded client
    // -side; anything else is the backend's call, so the CLI must not invent a
    // second, divergent date validator here.
    expect(resolveDateInput("08-06-2026", undefined)).toBe("08-06-2026");
  });

  test("the argName rides into both messages", () => {
    expect(errorOf(() => resolveDateInput(undefined, undefined, "pvm"))?.message).toMatch(
      /missing pvm/
    );
  });
});

describe("addOwnerOption (--owner is a route segment, so NaN must not survive)", () => {
  /** Parse argv through a throwaway command carrying only --owner. */
  const parseOwner = (value: string): number | undefined => {
    const cmd = addOwnerOption(new Command("t").exitOverride());
    cmd.action(() => {});
    cmd.parse(["--owner", value], { from: "user" });
    return cmd.opts().owner as number | undefined;
  };

  test("accepts a positive integer", () => {
    expect(parseOwner("27")).toBe(27);
  });

  test("rejects a non-numeric id with exit 4 instead of yielding NaN", () => {
    // Bare Number("abc") is NaN, which is NOT nullish — it survived
    // `opts.owner ?? resolveActiveOwnerAsiakasId(...)` and reached the wire as
    // /api/changes/latest/NaN.
    expect(exitCodeOf(() => parseOwner("abc"))).toBe(4);
  });

  test("rejects zero and negatives", () => {
    expect(exitCodeOf(() => parseOwner("0"))).toBe(4);
    expect(exitCodeOf(() => parseOwner("-3"))).toBe(4);
  });
});

describe("numFlag (fb#371 — lat/lng are route segments, so NaN must not survive)", () => {
  test("accepts finite floats, negatives, and trims surrounding space", () => {
    expect(numFlag("--lat")("60.1699")).toBe(60.1699);
    expect(numFlag("--lng")(" 24.9384 ")).toBe(24.9384);
    expect(numFlag("--x")("-3.5")).toBe(-3.5);
    expect(numFlag("--x")("0")).toBe(0);
  });

  test("rejects every non-finite form with exit 4", () => {
    // Empty is called out separately: Number("") is 0, a plausible-looking
    // coordinate rather than an obvious error, so it must not slip through.
    for (const bad of ["abc", "", "   ", "NaN", "Infinity", "-Infinity", "6O.17"]) {
      expect(exitCodeOf(() => numFlag("--lat")(bad))).toBe(4);
    }
  });

  test("bounds are opt-in and inclusive", () => {
    const metres = numFlag("--puomi-min", 0, 999.99);
    expect(metres("0")).toBe(0);
    expect(metres("999.99")).toBe(999.99);
    expect(exitCodeOf(() => metres("-0.1"))).toBe(4);
    expect(exitCodeOf(() => metres("1000"))).toBe(4);
    // Unbounded by default — a bare numFlag must not invent a range.
    expect(numFlag("--x")("-9999999")).toBe(-9999999);
  });

  test("names the flag, and the range only when one was set", () => {
    expect(errorOf(() => numFlag("--lat")("abc"))?.message).toBe(
      "--lat must be a number"
    );
    expect(errorOf(() => numFlag("--puomi-min", 0, 999.99)("abc"))?.message).toBe(
      "--puomi-min must be a number in 0..999.99"
    );
  });
});

describe("zeroOneFlag (fb#905 — 0|1 columns: out-of-range values silently fold to 1 server-side; NaN flies as null)", () => {
  test("accepts exactly 0 and 1", () => {
    expect(zeroOneFlag("--liita-laskuun")("0")).toBe(0);
    expect(zeroOneFlag("--liita-laskuun")("1")).toBe(1);
    expect(zeroOneFlag("--liita-laskuun")(" 1 ")).toBe(1);
  });

  test("rejects non-integers like intFlag, and integers > 1 with its own message", () => {
    for (const bad of ["abc", "", "2", "99", "-1", "1.5"]) {
      expect(exitCodeOf(() => zeroOneFlag("--liita-laskuun")(bad))).toBe(4);
    }
    expect(errorOf(() => zeroOneFlag("--liita-laskuun")("abc"))?.message).toBe(
      "--liita-laskuun must be an integer >= 0"
    );
    expect(errorOf(() => zeroOneFlag("--liita-laskuun")("2"))?.message).toBe(
      "--liita-laskuun must be 0 or 1"
    );
  });
});

describe("assertEnum (fb#369 — one retry, not a guess)", () => {
  const KINDS = ["improvement", "bug", "idea", "legal"] as const;

  test("undefined is a no-op and a listed value passes", () => {
    expect(() => assertEnum(undefined, KINDS, "--kind")).not.toThrow();
    expect(() => assertEnum("bug", KINDS, "--kind")).not.toThrow();
  });

  test("an unknown value exits 4 and lists the allowed set", () => {
    const err = errorOf(() => assertEnum("nonsense", KINDS, "--kind"));
    expect(err?.exitCode).toBe(4);
    expect(err?.message).toContain("--kind must be one of: improvement, bug, idea, legal");
  });

  test("a near miss names the intended value", () => {
    expect(errorOf(() => assertEnum("bugs", KINDS, "--kind"))?.message).toContain(
      "did you mean bug?"
    );
  });

  test("a synonym bridges what edit distance cannot", () => {
    const SEVERITIES = ["critical", "major", "minor", "cosmetic"] as const;
    // "high" is 5 edits from "major" — no fuzzy matcher reaches it.
    expect(
      errorOf(() => assertEnum("high", SEVERITIES, "--severity", { high: "major" }))?.message
    ).toContain("did you mean major?");
  });

  test("a synonym pointing outside the allowed set is dropped, not echoed", () => {
    expect(errorOf(() => assertEnum("high", KINDS, "--kind", { high: "urgent" }))?.message).not.toMatch(
      /did you mean/
    );
  });

  test("the allowed set always precedes the hint, so hintForError still matches", () => {
    // `hintForError` resolves a command's own remedy by the "must be one of"
    // substring — a hint prefixed ahead of it would strand every ERRORS row.
    const msg = errorOf(() => assertEnum("bugs", KINDS, "--kind"))?.message ?? "";
    expect(msg.indexOf("must be one of")).toBeLessThan(msg.indexOf("did you mean"));
  });
});
