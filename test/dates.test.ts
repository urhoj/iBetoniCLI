import { describe, test, expect, afterEach, vi } from "vitest";
import { resolveDate, resolveDateTime, todayHelsinki, addDaysISO, monthRange, weekRange } from "../src/dates.js";
import { CliError } from "../src/api/errors.js";

describe("resolveDate / todayHelsinki — Europe/Helsinki calendar date", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("summer: late UTC evening is already the next day in Helsinki (UTC+3)", () => {
    vi.useFakeTimers();
    // 2026-06-01 23:30 UTC === 2026-06-02 02:30 Europe/Helsinki (DST, +3)
    vi.setSystemTime(new Date("2026-06-01T23:30:00Z"));
    expect(todayHelsinki()).toBe("2026-06-02");
    expect(resolveDate("today")).toBe("2026-06-02");
    expect(resolveDate("yesterday")).toBe("2026-06-01");
    expect(resolveDate("tomorrow")).toBe("2026-06-03");
  });

  test("winter: late UTC evening rolls to next day in Helsinki (UTC+2)", () => {
    vi.useFakeTimers();
    // 2026-01-15 22:30 UTC === 2026-01-16 00:30 Europe/Helsinki (+2)
    vi.setSystemTime(new Date("2026-01-15T22:30:00Z"));
    expect(todayHelsinki()).toBe("2026-01-16");
    expect(resolveDate("today")).toBe("2026-01-16");
  });

  test("passes through an explicit date and undefined unchanged", () => {
    expect(resolveDate("2026-03-03")).toBe("2026-03-03");
    expect(resolveDate(undefined)).toBeUndefined();
  });
});

describe("addDaysISO / monthRange / weekRange", () => {
  test("addDaysISO shifts whole days", () => {
    expect(addDaysISO("2026-06-08", 6)).toBe("2026-06-14");
    expect(addDaysISO("2026-02-27", 2)).toBe("2026-03-01");
  });

  test("monthRange returns first→last day, leap-year aware", () => {
    expect(monthRange("2026-06")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  test("monthRange rejects malformed month", () => {
    expect(() => monthRange("2026-6")).toThrow();
    expect(() => monthRange("not-a-month")).toThrow();
  });

  test("weekRange spans start→start+6", () => {
    expect(weekRange("2026-06-08")).toEqual({ from: "2026-06-08", to: "2026-06-14" });
  });
});

describe("resolveDate accepts a read-shape date column (fb#357)", () => {
  test("reduces UTC midnight to the calendar day, with or without ms", () => {
    expect(resolveDate("2026-08-07T00:00:00.000Z")).toBe("2026-08-07");
    expect(resolveDate("2026-08-07T00:00:00Z")).toBe("2026-08-07");
  });

  test("leaves a plain YYYY-MM-DD untouched", () => {
    expect(resolveDate("2026-08-07")).toBe("2026-08-07");
  });

  test("passes a REAL timestamp through rather than guessing a timezone", () => {
    // 22:00Z is already the next day in Helsinki, so slicing would be a silent
    // off-by-one on exactly the boundary todayHelsinki exists to get right.
    // Let the backend validator reject it instead.
    expect(resolveDate("2026-08-06T22:00:00.000Z")).toBe("2026-08-06T22:00:00.000Z");
    expect(resolveDate("2026-08-07T13:45:00.000Z")).toBe("2026-08-07T13:45:00.000Z");
  });

  test("does not swallow a local-time midnight (no Z)", () => {
    expect(resolveDate("2026-08-07T00:00:00")).toBe("2026-08-07T00:00:00");
  });
});

describe("resolveDateTime — timestamp flags normalize to a UTC instant", () => {
  test("fb#412 repro: an offset is APPLIED, not dropped", () => {
    // Posting the raw string stored 12:00Z — a 3 h skew on every backdated
    // onboarding event, silently, behind an HTTP 200.
    expect(resolveDateTime("2026-08-11T12:00:00+03:00")).toBe("2026-08-11T09:00:00.000Z");
    expect(resolveDateTime("2026-01-15T12:00:00+02:00")).toBe("2026-01-15T10:00:00.000Z");
    expect(resolveDateTime("2026-08-11T12:00:00+0300")).toBe("2026-08-11T09:00:00.000Z");
  });

  test("an already-UTC value is normalized, not altered", () => {
    expect(resolveDateTime("2026-08-11T09:00:00Z")).toBe("2026-08-11T09:00:00.000Z");
    expect(resolveDateTime("2026-08-11T09:00:00.000Z")).toBe("2026-08-11T09:00:00.000Z");
  });

  test("offset-less input is Helsinki wall-clock, DST-aware", () => {
    expect(resolveDateTime("2026-08-11T12:00")).toBe("2026-08-11T09:00:00.000Z"); // EEST +3
    expect(resolveDateTime("2026-08-11T12:00:00")).toBe("2026-08-11T09:00:00.000Z");
    expect(resolveDateTime("2026-01-15T12:00")).toBe("2026-01-15T10:00:00.000Z"); // EET +2
    // Date-only = Helsinki midnight, which is the PREVIOUS UTC day in summer.
    expect(resolveDateTime("2026-08-11")).toBe("2026-08-10T21:00:00.000Z");
  });

  test("resolves both sides of the spring-forward transition", () => {
    // EU DST starts 2026-03-29 at 01:00 UTC (03:00 EET → 04:00 EEST).
    expect(resolveDateTime("2026-03-29T02:00")).toBe("2026-03-29T00:00:00.000Z"); // still +2
    expect(resolveDateTime("2026-03-29T05:00")).toBe("2026-03-29T02:00:00.000Z"); // now +3
    // 03:30 never happens; the two-pass lands just after the jump (04:30 EEST).
    expect(resolveDateTime("2026-03-29T03:30")).toBe("2026-03-29T01:30:00.000Z");
  });

  test("autumn fall-back picks the first (EEST) occurrence", () => {
    // 2026-10-25 01:00 UTC: 04:00 EEST → 03:00 EET.
    expect(resolveDateTime("2026-10-25T01:00")).toBe("2026-10-24T22:00:00.000Z");
  });

  test("undefined / empty passes through untouched", () => {
    expect(resolveDateTime(undefined)).toBeUndefined();
    expect(resolveDateTime("")).toBeUndefined();
  });

  test("garbage and out-of-range components exit 4 client-side, not at the backend", () => {
    for (const bad of ["not-a-date", "2026-13-01T10:00", "2026-08-11T25:00", "11.8.2026", "2026-08-11T12:00:00+99:00"]) {
      let caught: unknown;
      try {
        resolveDateTime(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught, bad).toBeInstanceOf(CliError);
      expect((caught as CliError).statusCode, bad).toBe(0);
      expect((caught as CliError).exitCode, bad).toBe(4);
    }
  });

  test("the error names the flag and both accepted shapes", () => {
    expect(() => resolveDateTime("nope", "--time")).toThrow(/--time/);
    expect(() => resolveDateTime("nope", "--time")).toThrow(/\+03:00/);
  });
});
