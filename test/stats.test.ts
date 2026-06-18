import { describe, test, expect, beforeEach } from "vitest";
import {
  enableStats,
  statsEnabled,
  recordRequest,
  parseServerTiming,
  buildStatsLine,
  resetStats,
} from "../src/stats.js";

describe("stats accumulator", () => {
  beforeEach(() => resetStats());

  test("disabled by default; recordRequest is a no-op until enabled", () => {
    expect(statsEnabled()).toBe(false);
    recordRequest({ apiMs: 100, serverTiming: null });
    expect(buildStatsLine(false)).toBeNull();
  });

  test("parseServerTiming extracts sql dur + proc count", () => {
    expect(parseServerTiming('sql;dur=45;desc="3 procs"')).toEqual({ sqlMs: 45, sqlProcCount: 3 });
    expect(parseServerTiming("sql;dur=12")).toEqual({ sqlMs: 12 });
    expect(parseServerTiming(null)).toEqual({});
    expect(parseServerTiming("app;dur=9")).toEqual({});
  });

  test("API-only invocation (no Server-Timing) emits api but omits sql fields", () => {
    enableStats();
    recordRequest({ apiMs: 120, serverTiming: null });
    expect(JSON.parse(buildStatsLine(false)!)).toEqual({ stats: { apiMs: 120 } });
  });

  test("sums multiple requests and includes apiReqCount + sql fields", () => {
    enableStats();
    recordRequest({ apiMs: 100, serverTiming: 'sql;dur=40;desc="2 procs"' });
    recordRequest({ apiMs: 50, serverTiming: 'sql;dur=5;desc="1 procs"' });
    expect(JSON.parse(buildStatsLine(false)!)).toEqual({
      stats: { apiMs: 150, apiReqCount: 2, sqlMs: 45, sqlProcCount: 3, sqlCoverage: "executeQuery-path-only" },
    });
  });

  test("pretty line is human-readable", () => {
    enableStats();
    recordRequest({ apiMs: 120, serverTiming: 'sql;dur=45;desc="3 procs"' });
    expect(buildStatsLine(true)).toBe("[ib] stats: api=120ms sql=45ms (3 procs, executeQuery-path-only)");
  });
});
