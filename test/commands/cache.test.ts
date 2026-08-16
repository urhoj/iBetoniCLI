import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { assertWritableEndpoint } from "../../src/api/endpointGuard.js";
import { CliError } from "../../src/api/errors.js";
import { CACHE_ENTITIES } from "../../src/commands/cache/entities.js";
import {
  runCacheStats,
  runCacheKeys,
  runCacheInvalidate,
  runCacheClear,
  runCachePattern,
  resolveGlob,
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

const mockClient = mockApiClient({ endpoint: "http://127.0.0.1:3000" });

describe("ib cache run* functions", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.post.mockReset();
  });

  test("runCacheStats GETs /api/cli/cache/stats", async () => {
    mockClient.get.mockResolvedValueOnce({ connected: true, totalKeys: 5 });
    const out = await runCacheStats(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/cache/stats");
    expect(out).toEqual({ connected: true, totalKeys: 5 });
  });

  test("runCacheKeys passes the pattern query", async () => {
    mockClient.get.mockResolvedValueOnce({ totalKeys: 0, groups: [] });
    await runCacheKeys(mockClient, { pattern: "keikka:*" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/cache/keys?pattern=keikka%3A*");
  });

  test("runCacheInvalidate defaults to dry-run when not confirmed (read POST, X-Dry-Run)", async () => {
    mockClient.post.mockResolvedValueOnce({ dryRun: true, wouldDelete: 2 });
    await runCacheInvalidate(mockClient, { entityType: "keikka", id: 123 }, { confirm: false, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/invalidate",
      { entityType: "keikka", id: 123, cascade: false },
      { headers: { "X-Dry-Run": "1" }, read: true }
    );
  });

  test("runCacheInvalidate with --confirm sends a real write (no X-Dry-Run, no read flag)", async () => {
    mockClient.post.mockResolvedValueOnce({ dryRun: false, deleted: 5 });
    await runCacheInvalidate(mockClient, { entityType: "keikka", id: 123 }, { confirm: true, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/invalidate",
      { entityType: "keikka", id: 123, cascade: false },
      { headers: {} }
    );
  });

  test("runCacheClear --confirm sends confirmed:true", async () => {
    mockClient.post.mockResolvedValueOnce({ deleted: 900 });
    await runCacheClear(mockClient, { confirm: true, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith("/api/cli/cache/clear", { confirmed: true }, { headers: {} });
  });

  test("runCacheClear preview (no confirm) sends X-Dry-Run + read", async () => {
    mockClient.post.mockResolvedValueOnce({ dryRun: true, wouldDelete: 1234 });
    await runCacheClear(mockClient, { confirm: false, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith("/api/cli/cache/clear", { confirmed: false }, { headers: { "X-Dry-Run": "1" }, read: true });
  });

  test("runCachePattern --confirm sends pattern + confirmed:true", async () => {
    mockClient.post.mockResolvedValueOnce({ deleted: 4 });
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
    mockClient.post.mockResolvedValueOnce({ deleted: 10 });
    await runCacheClear(mockClient, { confirm: true, forceProd: true });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/clear",
      { confirmed: true },
      { headers: { "X-Force-Prod": "1" } }
    );
  });

  test("runCacheInvalidate with --confirm --force-prod sends the X-Force-Prod header", async () => {
    mockClient.post.mockResolvedValueOnce({ deleted: 1 });
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

// fb#645 — this group INVERTS the CLI-wide write-safety idiom (previews by
// default, --confirm applies). `--dry-run` is accepted as an explicit spelling
// of that default so an agent moving here from any other write command is not
// told the capability is missing — the direction of that mistake is what makes
// it dangerous, because the flag it pushes you toward is the one that deletes.
describe("cache write-safety idiom (fb#645)", () => {
  // Local endpoint: the shared-cache guard is a SEPARATE refusal (covered above),
  // and letting it fire here would mask whether the dry-run guard ran at all.
  let mockClient: ReturnType<typeof mockApiClient>;
  beforeEach(() => {
    mockClient = mockApiClient({ endpoint: "http://127.0.0.1:3000" });
  });

  test("--dry-run alone previews exactly like the bare default", async () => {
    mockClient.post.mockResolvedValue({ dryRun: true, wouldDelete: 3 });
    await runCachePattern(mockClient, "geocode:cli:*", {
      confirm: false,
      dryRun: true,
      forceProd: false,
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/pattern",
      { pattern: "geocode:cli:*", confirmed: false },
      { headers: { "X-Dry-Run": "1" }, read: true }
    );
  });

  test("--dry-run does not weaken --confirm into a preview: it refuses (exit 4)", async () => {
    await expect(
      runCachePattern(mockClient, "keikka:*", { confirm: true, dryRun: true, forceProd: false })
    ).rejects.toThrow(/mutually exclusive/);
    // The decisive assertion: nothing was sent either way round.
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("the contradiction is refused on clear and invalidate too", async () => {
    await expect(
      runCacheClear(mockClient, { confirm: true, dryRun: true, forceProd: false })
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      runCacheInvalidate(
        mockClient,
        { entityType: "keikka", id: 1 },
        { confirm: true, dryRun: true, forceProd: false }
      )
    ).rejects.toThrow(/mutually exclusive/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("omitting dryRun entirely keeps the pre-fb#645 behaviour", async () => {
    mockClient.post.mockResolvedValue({ deleted: 2 });
    await runCacheClear(mockClient, { confirm: true, forceProd: false });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/cache/clear",
      { confirmed: true },
      { headers: {} }
    );
  });
});

// fb#645 — `cache keys --pattern <glob>` vs `cache pattern <glob>`: one concept,
// two syntaxes. Reaching for --pattern on the latter is the natural error.
describe("resolveGlob dual-shape (fb#645)", () => {
  test("accepts the positional (canonical)", () => {
    expect(resolveGlob("keikka:*", undefined)).toBe("keikka:*");
  });

  test("accepts --pattern, the sibling command's spelling", () => {
    expect(resolveGlob(undefined, "keikka:*")).toBe("keikka:*");
  });

  test("accepts both when they agree", () => {
    expect(resolveGlob("keikka:*", "keikka:*")).toBe("keikka:*");
  });

  test("refuses two DIFFERENT globs rather than silently honouring one", () => {
    expect(() => resolveGlob("keikka:*", "person:*")).toThrow(/differ/);
  });

  test("refuses neither, naming both ways to pass it", () => {
    expect(() => resolveGlob(undefined, undefined)).toThrow(/--pattern/);
  });

  test("an empty glob is refused, not sent as a match-nothing pattern", () => {
    expect(() => resolveGlob("", undefined)).toThrow(/missing target/);
  });
});
