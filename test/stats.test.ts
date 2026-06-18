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

  test("parseServerTiming extracts cacheHit / cacheMiss alongside sql", () => {
    expect(parseServerTiming('sql;dur=1152;desc="1 procs", cacheHit;dur=0, cacheMiss;dur=1')).toEqual({
      sqlMs: 1152,
      sqlProcCount: 1,
      cacheHits: 0,
      cacheMisses: 1,
    });
    expect(parseServerTiming("cacheHit;dur=2, cacheMiss;dur=0")).toEqual({ cacheHits: 2, cacheMisses: 0 });
  });

  test("cache HIT: sql=0 but cache fields present (the repeat-query case)", () => {
    enableStats();
    recordRequest({ apiMs: 150, serverTiming: 'sql;dur=0;desc="0 procs", cacheHit;dur=1, cacheMiss;dur=0' });
    expect(JSON.parse(buildStatsLine(false)!)).toEqual({
      stats: { apiMs: 150, sqlMs: 0, sqlProcCount: 0, sqlCoverage: "executeQuery-path-only", cacheHits: 1, cacheMisses: 0 },
    });
  });

  test("cache fields absent when the backend sent no cache metrics", () => {
    enableStats();
    recordRequest({ apiMs: 90, serverTiming: 'sql;dur=12;desc="1 procs"' });
    const stats = JSON.parse(buildStatsLine(false)!).stats;
    expect(stats.cacheHits).toBeUndefined();
    expect(stats.cacheMisses).toBeUndefined();
  });

  test("pretty line includes the cache segment when present", () => {
    enableStats();
    recordRequest({ apiMs: 1347, serverTiming: 'sql;dur=1152;desc="1 procs", cacheHit;dur=0, cacheMiss;dur=1' });
    expect(buildStatsLine(true)).toBe(
      "[ib] stats: api=1347ms sql=1152ms (1 procs, executeQuery-path-only) cache=0 hit / 1 miss"
    );
  });

  test("sums cache hits/misses across multiple requests", () => {
    enableStats();
    recordRequest({ apiMs: 10, serverTiming: "cacheHit;dur=1, cacheMiss;dur=0" });
    recordRequest({ apiMs: 20, serverTiming: "cacheHit;dur=0, cacheMiss;dur=2" });
    expect(JSON.parse(buildStatsLine(false)!)).toEqual({
      stats: { apiMs: 30, apiReqCount: 2, cacheHits: 1, cacheMisses: 2 },
    });
  });
});
