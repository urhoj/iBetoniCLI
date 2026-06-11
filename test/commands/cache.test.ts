import { describe, test, expect, vi, beforeEach } from "vitest";
import { assertWritableEndpoint } from "../../src/api/endpointGuard.js";
import { CliError } from "../../src/api/errors.js";
import { CACHE_ENTITIES } from "../../src/commands/cache/entities.js";
import {
  runCacheStats,
  runCacheKeys,
  runCacheInvalidate,
  runCacheClear,
  runCachePattern,
} from "../../src/commands/cache/index.js";
import type { ApiClient } from "../../src/api/client.js";

describe("assertWritableEndpoint", () => {
  test("allows localhost without --force-prod", () => {
    expect(() => assertWritableEndpoint("http://127.0.0.1:3000", false)).not.toThrow();
    expect(() => assertWritableEndpoint("http://localhost:3000", false)).not.toThrow();
  });

  test("refuses a remote endpoint without --force-prod (exit 3)", () => {
    try {
      assertWritableEndpoint("https://api.ibetoni.fi", false);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(3);
    }
  });

  test("allows a remote endpoint when forceProd is true", () => {
    expect(() => assertWritableEndpoint("https://api.ibetoni.fi", true)).not.toThrow();
  });
});

describe("CACHE_ENTITIES vocabulary", () => {
  test("is a non-empty list of {entityType, params, example}", () => {
    expect(CACHE_ENTITIES.length).toBeGreaterThan(5);
    for (const e of CACHE_ENTITIES) {
      expect(typeof e.entityType).toBe("string");
      expect(Array.isArray(e.params)).toBe(true);
      expect(typeof e.example).toBe("string");
    }
  });

  test("includes keikka with cascade support flagged", () => {
    const keikka = CACHE_ENTITIES.find((e) => e.entityType === "keikka");
    expect(keikka).toBeDefined();
    expect(keikka!.cascade).toBe(true);
  });
});

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
  endpoint: "http://127.0.0.1:3000",
} as unknown as ApiClient;

describe("ib cache run* functions", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.post as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runCacheStats GETs /api/cli/cache/stats", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ connected: true, totalKeys: 5 });
    const out = await runCacheStats(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/cache/stats");
    expect(out).toEqual({ connected: true, totalKeys: 5 });
  });

  test("runCacheKeys passes the pattern query", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ totalKeys: 0, groups: [] });
    await runCacheKeys(mockClient, { pattern: "keikka:*" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/cache/keys?pattern=keikka%3A*");
  });

  test("runCacheInvalidate defaults to dry-run when not confirmed (read POST, X-Dry-Run)", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: true, wouldDelete: 2 });
    await runCacheInvalidate(mockClient, { entityType: "keikka", id: 123 }, { confirm: false, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/invalidate",
      { entityType: "keikka", id: 123, cascade: false },
      { headers: { "X-Dry-Run": "1" }, read: true }
    );
  });

  test("runCacheInvalidate with --confirm sends a real write (no X-Dry-Run, no read flag)", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: false, deleted: 5 });
    await runCacheInvalidate(mockClient, { entityType: "keikka", id: 123 }, { confirm: true, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/invalidate",
      { entityType: "keikka", id: 123, cascade: false },
      { headers: {} }
    );
  });

  test("runCacheClear --confirm sends confirmed:true", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 900 });
    await runCacheClear(mockClient, { confirm: true, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith("/api/cli/cache/clear", { confirmed: true }, { headers: {} });
  });

  test("runCacheClear preview (no confirm) sends X-Dry-Run + read", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ dryRun: true, wouldDelete: 1234 });
    await runCacheClear(mockClient, { confirm: false, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith("/api/cli/cache/clear", { confirmed: false }, { headers: { "X-Dry-Run": "1" }, read: true });
  });

  test("runCachePattern --confirm sends pattern + confirmed:true", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 4 });
    await runCachePattern(mockClient, "keikka:*", { confirm: true, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/pattern",
      { pattern: "keikka:*", confirmed: true },
      { headers: {} }
    );
  });

  test("runCacheInvalidate refuses a remote endpoint on execute without forceProd", async () => {
    const remote = { ...mockClient, endpoint: "https://api.ibetoni.fi" } as unknown as ApiClient;
    await expect(
      runCacheInvalidate(remote, { entityType: "keikka", id: 1 }, { confirm: true, forceProd: false })
    ).rejects.toThrow(/Refused/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("runCacheClear with --confirm --force-prod sends the X-Force-Prod header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 10 });
    await runCacheClear(mockClient, { confirm: true, forceProd: true });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/clear",
      { confirmed: true },
      { headers: { "X-Force-Prod": "1" } }
    );
  });

  test("runCacheInvalidate with --confirm --force-prod sends the X-Force-Prod header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 1 });
    await runCacheInvalidate(
      mockClient,
      { entityType: "vehicle", id: 5 },
      { confirm: true, forceProd: true }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/invalidate",
      { entityType: "vehicle", cascade: false, id: 5 },
      { headers: { "X-Force-Prod": "1" } }
    );
  });
});
