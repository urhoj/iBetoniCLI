/**
 * fb#228 — `changelog add --repo <csv>` false-positive fail-safe warning.
 * The warning must mirror the deploy planner (computeReleasePlan.js): it
 * fires ONLY when the CSV resolves to coordinated=[] AND canonical=[]
 * (nothing recognized), not on a whole-CSV membership test.
 */
import { test, expect, vi, beforeEach, afterEach, describe } from "vitest";
import { Command } from "commander";
import { registerChangelogCommands } from "../../src/commands/changelog/index.js";
import { COORDINATED, normalizeRepoToken, normalizeRepoCsv } from "../../src/commands/changelog/repos.js";
import type { ApiClient } from "../../src/api/client.js";

describe("normalizeRepoCsv (mirror of puminet5api/modules/changelog/repos.js)", () => {
  test("mixed CSV: coordinated + @ibetoni passthrough, nothing unknown (the fb#228 case)", () => {
    const r = normalizeRepoCsv("puminet7-functions-app,puminet5api,@ibetoni/prh-utils");
    expect(r.coordinated).toEqual(["puminet7-functions-app", "puminet5api"]);
    expect(r.canonical).toBe("puminet7-functions-app,puminet5api,@ibetoni/prh-utils");
    expect(r.unknown).toEqual([]);
  });

  test("aliases resolve to canonical coordinated repos", () => {
    expect(normalizeRepoCsv("be").coordinated).toEqual(["puminet5api"]);
    expect(normalizeRepoCsv("fe, jerry").coordinated).toEqual(["puminet4", "betonijerry"]);
  });

  test("standalone lane: recognized but not coordinated", () => {
    for (const csv of ["betonicli", "@ibetoni/cache", "dbo.keikka", "ibetoni-site"]) {
      const r = normalizeRepoCsv(csv);
      expect(r.coordinated).toEqual([]);
      expect(r.canonical).not.toBe("");
      expect(r.unknown).toEqual([]);
    }
  });

  test("unknown tokens land in unknown; empty/blank CSV resolves to nothing", () => {
    expect(normalizeRepoCsv("foobar")).toEqual({ canonical: "", coordinated: [], unknown: ["foobar"] });
    expect(normalizeRepoCsv("")).toEqual({ canonical: "", coordinated: [], unknown: [] });
    expect(normalizeRepoCsv("puminet5api,foobar")).toMatchObject({ coordinated: ["puminet5api"], unknown: ["foobar"] });
  });

  test("dedupes repeated tokens", () => {
    expect(normalizeRepoCsv("be,backend,puminet5api")).toEqual({
      canonical: "puminet5api", coordinated: ["puminet5api"], unknown: [],
    });
  });

  test("normalizeRepoToken passthroughs and null on unknown", () => {
    expect(normalizeRepoToken("@ibetoni/prh-utils")).toBe("@ibetoni/prh-utils");
    expect(normalizeRepoToken("dbo.helps")).toBe("dbo.helps");
    expect(normalizeRepoToken("nope")).toBeNull();
    expect(normalizeRepoToken("")).toBeNull();
  });

  test("COORDINATED matches the deploy planner set", () => {
    expect(COORDINATED).toEqual(["puminet4", "puminet5api", "puminet7-functions-app", "betonijerry", "workspace"]);
  });
});

describe("changelog add --repo fail-safe warning (fb#228)", () => {
  const client = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() } as unknown as ApiClient;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ changelogId: 1 });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  const add = async (repo: string, extra: string[] = []) => {
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", "--repo", repo, ...extra],
      { from: "user" }
    );
  };
  const failSafeWarned = () =>
    errSpy.mock.calls.some((c) => String(c[0]).includes("fail-safe-bumps"));

  test("valid mixed CSV (2 coordinated + 1 @ibetoni passthrough) does NOT warn", async () => {
    await add("puminet7-functions-app,puminet5api,@ibetoni/prh-utils");
    expect(failSafeWarned()).toBe(false);
  });

  test("alias --repo be does NOT warn", async () => {
    await add("be");
    expect(failSafeWarned()).toBe(false);
  });

  test("recognized standalone-lane --repo betonicli does NOT warn (no fail-safe bump happens)", async () => {
    await add("betonicli");
    expect(failSafeWarned()).toBe(false);
  });

  test("fully unresolved --repo DOES warn", async () => {
    await add("totally-unknown-repo");
    expect(failSafeWarned()).toBe(true);
  });

  test("unresolved --repo with --bump-level none does NOT warn", async () => {
    await add("totally-unknown-repo", ["--bump-level", "none"]);
    expect(failSafeWarned()).toBe(false);
  });
});
