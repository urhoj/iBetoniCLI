import { describe, test, expect, afterEach, vi } from "vitest";
import { resolveDate, todayHelsinki } from "../src/dates.js";

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
