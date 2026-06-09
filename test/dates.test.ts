import { describe, test, expect, afterEach, vi } from "vitest";
import { resolveDate, todayHelsinki, addDaysISO, monthRange, weekRange } from "../src/dates.js";

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
