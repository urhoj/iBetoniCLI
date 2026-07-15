import { test, expect, vi, beforeEach, describe } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChangelogAdd, runChangelogList, runChangelogReport, runChangelogGet, runChangelogUpdate, runChangelogDelete, normalizeSentryRef, normalizeLanguage, normalizeType, readJsonInput, validateEnums, validateFieldLengths, resolveChangelogDescription, resolveShaAlias }
  from "../../src/commands/changelog/index.js";
import type { ChangelogAddBody } from "../../src/commands/changelog/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { writeFlagsToHeaders } from "../../src/api/writeFlags.js";

const client = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() } as unknown as ApiClient;

/** Run a fn expected to throw and return the thrown value for structural assertions. */
function captureThrow(fn: () => void): { exitCode?: number; body?: { problems?: Array<{ flag: string; got?: string; allowed?: string[]; synonyms?: Record<string, string> }>; sample?: string } } {
  try {
    fn();
  } catch (e) {
    return e as never;
  }
  throw new Error("expected fn to throw");
}

const asPost = () => client.post as ReturnType<typeof vi.fn>;
const asGet = () => client.get as ReturnType<typeof vi.fn>;
const asPut = () => client.put as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

test("add posts the entry with feedback link", async () => {
  asPost().mockResolvedValue({ changelogId: 7 });
  await runChangelogAdd(client,
    { type: "bugfix", area: "cli", title: "t", description: "d", entryDate: "2026-06-14", feedbackId: 12 }, {});
  expect(asPost()).toHaveBeenCalledWith("/api/changelog",
    expect.objectContaining({ type: "bugfix", area: "cli", feedbackId: 12 }), { headers: {} });
});

test("add --dry-run posts with X-Dry-Run so the server validates + echoes", async () => {
  asPost().mockResolvedValue({ dryRun: true, wouldCreate: { type: "feature" }, validation: { ok: true } });
  const r = await runChangelogAdd(client,
    { type: "feature", area: "cli", title: "t", description: "d", entryDate: "2026-06-14" }, { dryRun: true });
  expect(asPost()).toHaveBeenCalledWith("/api/changelog",
    expect.objectContaining({ type: "feature" }), { headers: { "X-Dry-Run": "1" } });
  expect(r).toMatchObject({ dryRun: true });
});

test("report fetches the generated markdown", async () => {
  asGet().mockResolvedValue({ month: "2026-06", markdown: "# x" });
  const r = await runChangelogReport(client, "2026-06", "md");
  expect(asGet()).toHaveBeenCalledWith("/api/changelog/report?month=2026-06&format=md");
  expect(r).toEqual({ month: "2026-06", markdown: "# x" });
});

test("list builds the query string", async () => {
  asGet().mockResolvedValue([{ changelogId: 1 }]);
  await runChangelogList(client, { month: "2026-06", type: "feature" });
  expect(asGet()).toHaveBeenCalledWith("/api/changelog?month=2026-06&type=feature");
});

test("list maps --feedback to the feedbackId query param", async () => {
  asGet().mockResolvedValue([]);
  await runChangelogList(client, { feedback: 12 });
  expect(asGet()).toHaveBeenCalledWith("/api/changelog?feedbackId=12");
});

test("get fetches the entry url", async () => {
  asGet().mockResolvedValue({ changelogId: 7 });
  await runChangelogGet(client, 7);
  expect(asGet()).toHaveBeenCalledWith("/api/changelog/7");
});

test("update --dry-run never puts", async () => {
  const r = await runChangelogUpdate(client, 7, { status: "Deployed" }, { dryRun: true });
  expect(r).toMatchObject({ dryRun: true, wouldUpdate: { id: 7, patch: { status: "Deployed" } } });
  expect(asPut()).not.toHaveBeenCalled();
});

test("update puts language in the patch body", async () => {
  asPut().mockResolvedValue({ changelogId: 7, language: "en" });
  await runChangelogUpdate(client, 7, { language: "en" }, {});
  expect(asPut()).toHaveBeenCalledWith("/api/changelog/7",
    expect.objectContaining({ language: "en" }), { headers: {} });
});

test("delete --dry-run never issues a DELETE", async () => {
  const r = await runChangelogDelete(client, 7, { dryRun: true });
  expect(r).toEqual({ dryRun: true, wouldDelete: { id: 7 } });
  expect(client.delete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
});

test("delete issues DELETE /api/changelog/:id with the write headers", async () => {
  const asDelete = client.delete as ReturnType<typeof vi.fn>;
  asDelete.mockResolvedValue({ deleted: true });
  const r = await runChangelogDelete(client, 7, { reason: "cleanup" });
  expect(asDelete).toHaveBeenCalledWith("/api/changelog/7",
    { headers: writeFlagsToHeaders({ reason: "cleanup" }) });
  expect(r).toEqual({ deleted: true });
});

test("add posts language in the body", async () => {
  asPost().mockResolvedValue({ changelogId: 9 });
  await runChangelogAdd(client,
    { type: "feature", area: "cli", title: "t", description: "d", entryDate: "2026-06-21", language: "en" }, {});
  expect(asPost()).toHaveBeenCalledWith("/api/changelog",
    expect.objectContaining({ language: "en" }), { headers: {} });
});

test("normalizeLanguage lowercases, trims, and passes undefined through", () => {
  expect(normalizeLanguage("EN")).toBe("en");
  expect(normalizeLanguage("  fi ")).toBe("fi");
  expect(normalizeLanguage(undefined)).toBeUndefined();
});

test("normalizeLanguage rejects an unsupported code (exit 4)", () => {
  expect(() => normalizeLanguage("de")).toThrow(/fi\|en/);
});

describe("normalizeType conventional-commit synonyms (fb#188)", () => {
  test("maps fix→bugfix and feat→feature", () => {
    expect(normalizeType("fix")).toBe("bugfix");
    expect(normalizeType("feat")).toBe("feature");
  });

  test("trims and lowercases before matching", () => {
    expect(normalizeType("  FIX ")).toBe("bugfix");
    expect(normalizeType("Feat")).toBe("feature");
  });

  test("passes canonical values through unchanged", () => {
    expect(normalizeType("bugfix")).toBe("bugfix");
    expect(normalizeType("feature")).toBe("feature");
    expect(normalizeType("improvement")).toBe("improvement");
  });

  test("passes an unknown value through (lowercased) for validateEnums to reject", () => {
    expect(normalizeType("nonsense")).toBe("nonsense");
    // Allowed values now live in the structured problems[] body (fb#204), not the
    // message string — the caller gets them + synonyms + a sample in one response.
    const err = captureThrow(() => validateEnums(normalizeType("nonsense")));
    expect(err.exitCode).toBe(4);
    const p = err.body?.problems?.[0];
    expect(p).toMatchObject({ flag: "--type", issue: "invalid", got: "nonsense" });
    expect(p?.allowed).toEqual(["feature", "improvement", "bugfix"]);
    expect(p?.synonyms).toMatchObject({ fix: "bugfix", feat: "feature" });
    expect(err.body?.sample).toContain("ib dev changelog add");
  });

  test("passes undefined through", () => {
    expect(normalizeType(undefined)).toBeUndefined();
  });

  test("the mapped synonym then passes validateEnums", () => {
    expect(() => validateEnums(normalizeType("fix"))).not.toThrow();
    expect(() => validateEnums(normalizeType("feat"))).not.toThrow();
  });
});

test("normalizeSentryRef returns a bare short id unchanged", () => {
  expect(normalizeSentryRef("PUMINET5API-1A2")).toBe("PUMINET5API-1A2");
});

test("normalizeSentryRef extracts the short id from a url", () => {
  expect(normalizeSentryRef("https://sentry.io/issues/?query=PUMINET5API-1A2")).toBe("PUMINET5API-1A2");
});

test("normalizeSentryRef trims and caps non-matching input at 64 chars", () => {
  expect(normalizeSentryRef("  weird ref  ")).toBe("weird ref");
  expect(normalizeSentryRef("x".repeat(80)).length).toBe(64);
});

test("add posts the entry with sentry link", async () => {
  asPost().mockResolvedValue({ changelogId: 8 });
  await runChangelogAdd(client,
    { type: "bugfix", area: "backend", title: "t", description: "d", entryDate: "2026-06-15", sentryIssue: "PUMINET5API-1A2" }, {});
  expect(asPost()).toHaveBeenCalledWith("/api/changelog",
    expect.objectContaining({ sentryIssue: "PUMINET5API-1A2" }), { headers: {} });
});

test("list maps --sentry to the sentryIssue query param", async () => {
  asGet().mockResolvedValue([]);
  await runChangelogList(client, { sentry: "PUMINET5API-1A2" });
  expect(asGet()).toHaveBeenCalledWith("/api/changelog?sentryIssue=PUMINET5API-1A2");
});

test("list normalizes a pasted --sentry url to the short id", async () => {
  asGet().mockResolvedValue([]);
  await runChangelogList(client, { sentry: "https://sentry.io/issues/?query=PUMINET5API-1A2" });
  expect(asGet()).toHaveBeenCalledWith("/api/changelog?sentryIssue=PUMINET5API-1A2");
});

function mockClient() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ changelogId: 1 }),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  };
}

describe("changelog add bumpLevel", () => {
  test("posts bumpLevel in the body", async () => {
    const client = mockClient();
    const body: ChangelogAddBody = {
      type: "feature", area: "cli", title: "t", description: "d",
      entryDate: "2026-06-18", bumpLevel: "minor",
    };
    await runChangelogAdd(client as never, body, {});
    expect(client.post).toHaveBeenCalledWith(
      "/api/changelog",
      expect.objectContaining({ bumpLevel: "minor" }),
      expect.any(Object)
    );
  });
});

import { runChangelogPending, runChangelogRelease, runChangelogReleaseMap, registerChangelogCommands } from "../../src/commands/changelog/index.js";
import { Command } from "commander";

describe("changelog pending/release", () => {
  test("pending GETs /api/changelog/pending", async () => {
    const client = mockClient();
    client.get.mockResolvedValue({ entries: [], maxBumpLevel: null, count: 0 });
    const r = await runChangelogPending(client as never);
    expect(client.get).toHaveBeenCalledWith("/api/changelog/pending");
    expect(r).toEqual({ entries: [], maxBumpLevel: null, count: 0 });
  });

  test("release POSTs versionTag with write headers", async () => {
    const client = mockClient();
    client.post.mockResolvedValue({ released: 3, versionTag: "1.0.8" });
    await runChangelogRelease(client as never, "1.0.8", { reason: "release 1.0.8" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/changelog/release",
      { versionTag: "1.0.8" },
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });
});

describe("changelog release --map", () => {
  test("posts { map } to /api/changelog/release with write headers", async () => {
    const c = mockClient();
    c.post.mockResolvedValue({ released: 2, mode: "map" });
    const map = [
      { changelogId: 7, versionTag: "puminet5api@0.62.13" },
      { changelogId: 8, versionTag: "puminet4@0.62.10" },
    ];
    await runChangelogReleaseMap(c as never, map, { reason: "release" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/changelog/release",
      { map },
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });
});

describe("changelog --source flag", () => {
  test("add --source routine puts source in the POST body", async () => {
    const c = mockClient();
    await runChangelogAdd(c as never,
      { type: "feature", area: "cli", title: "t", description: "d", entryDate: "2026-06-22", source: "routine" }, {});
    expect(c.post).toHaveBeenCalledWith("/api/changelog",
      expect.objectContaining({ source: "routine" }), expect.any(Object));
  });

  test("add --source xxx fails validation (exit 4)", () => {
    const err = captureThrow(() => validateEnums(undefined, undefined, undefined, "xxx"));
    expect(err.exitCode).toBe(4);
    const p = err.body?.problems?.[0];
    expect(p).toMatchObject({ flag: "--source", issue: "invalid", got: "xxx" });
    expect(p?.allowed).toEqual(["human", "routine"]);
  });

  test("multiple bad enums are reported together (aggregated) with a sample", () => {
    const err = captureThrow(() => validateEnums("nope", "bogus", "huge", "alien"));
    expect(err.exitCode).toBe(4);
    const flags = (err.body?.problems ?? []).map((p) => p.flag);
    expect(flags).toEqual(["--type", "--area", "--bump-level", "--source"]);
    expect(err.body?.sample).toContain("ib dev changelog add");
  });

  test("list --source routine maps to the source query param", async () => {
    const c = mockClient();
    c.get.mockResolvedValue([]);
    await runChangelogList(c as never, { source: "routine" });
    expect(c.get).toHaveBeenCalledWith("/api/changelog?source=routine");
  });
});

describe("--area repo-name remedy (fb#212)", () => {
  test("--area jerry carries a remedy pointing at --repo betonijerry", () => {
    const err = captureThrow(() => validateEnums(undefined, "jerry"));
    expect(err.exitCode).toBe(4);
    const p = err.body?.problems?.[0];
    expect(p).toMatchObject({ flag: "--area", issue: "invalid", got: "jerry" });
    expect(p?.allowed).toEqual(["frontend", "backend", "cli", "database", "cicd"]);
    expect(p?.remedy).toContain("--repo betonijerry");
  });

  test("--area puminet5api remedies to --repo puminet5api (case-insensitive)", () => {
    const err = captureThrow(() => validateEnums(undefined, "Puminet5api"));
    expect(err.body?.problems?.[0]?.remedy).toContain("--repo puminet5api");
  });

  test("a non-repo-shaped invalid --area gets no remedy, just the allowed list", () => {
    const err = captureThrow(() => validateEnums(undefined, "bogus"));
    const p = err.body?.problems?.[0];
    expect(p?.allowed).toEqual(["frontend", "backend", "cli", "database", "cicd"]);
    expect(p?.remedy).toBeUndefined();
  });
});

describe("validateFieldLengths — bounded free-text caps (fb#206)", () => {
  test("rejects an over-length --status (30-char varchar) with exit 4 naming the cap", () => {
    const err = captureThrow(() => validateFieldLengths({ status: "x".repeat(31) }));
    expect(err.exitCode).toBe(4);
    expect((err as unknown as Error).message).toMatch(/--status/);
    expect((err as unknown as Error).message).toMatch(/30/);
    expect((err as unknown as Error).message).toMatch(/31/);
  });

  test("passes a --status exactly at the 30-char boundary", () => {
    expect(() => validateFieldLengths({ status: "x".repeat(30) })).not.toThrow();
  });

  test("aggregates every over-length field in one error", () => {
    const err = captureThrow(() =>
      validateFieldLengths({ status: "x".repeat(31), severity: "y".repeat(21) })
    );
    expect(err.exitCode).toBe(4);
    expect((err as unknown as Error).message).toMatch(/--status/);
    expect((err as unknown as Error).message).toMatch(/--severity/);
  });

  test("ignores undefined and within-limit fields", () => {
    expect(() =>
      validateFieldLengths({ status: "Deployed", title: "short title", repo: "puminet5api" })
    ).not.toThrow();
  });

  test("checks --sha/--vtag which map to longer columns", () => {
    expect(() => validateFieldLengths({ sha: "a".repeat(500) })).not.toThrow();
    expect(() => validateFieldLengths({ sha: "a".repeat(501) })).toThrow(/--sha/);
    expect(() => validateFieldLengths({ vtag: "v".repeat(201) })).toThrow(/--vtag/);
  });

  test("add with an over-length --status exits 4 without POSTing (fb#206)", async () => {
    // validateFieldLengths runs (like validateEnums) outside the action try, so
    // the CliError propagates out of parseAsync to the bin's CliError-aware catch
    // (exit 4) — the POST is never reached.
    asPost().mockResolvedValue({ changelogId: 1 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await expect(program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", "--status", "x".repeat(40)],
      { from: "user" }
    )).rejects.toMatchObject({ exitCode: 4 });
    expect(asPost()).not.toHaveBeenCalled();
  });
});

describe("changelog add description positional-or-flag (fb#172)", () => {
  test("resolves the positional when no --description", () => {
    expect(resolveChangelogDescription("from positional", undefined)).toBe("from positional");
  });

  test("resolves --description when no positional", () => {
    expect(resolveChangelogDescription(undefined, "from flag")).toBe("from flag");
  });

  test("accepts both when they agree", () => {
    expect(resolveChangelogDescription("same", "same")).toBe("same");
  });

  test("rejects conflicting positional and --description (exit 4)", () => {
    expect(() => resolveChangelogDescription("one", "two")).toThrow(/must match/);
  });

  test("rejects when neither is given (exit 4)", () => {
    expect(() => resolveChangelogDescription(undefined, undefined)).toThrow(/description.*required/);
  });

  test("treats whitespace-only as absent", () => {
    expect(() => resolveChangelogDescription("   ", undefined)).toThrow(/required/);
  });
});

describe("changelog --summary alias for --description (fb#205)", () => {
  test("resolves --summary alone", () => {
    expect(resolveChangelogDescription(undefined, undefined, "from summary")).toBe("from summary");
  });

  test("accepts --summary agreeing with --description / positional", () => {
    expect(resolveChangelogDescription(undefined, "same", "same")).toBe("same");
    expect(resolveChangelogDescription("same", undefined, "same")).toBe("same");
  });

  test("rejects --summary conflicting with --description (exit 4)", () => {
    expect(() => resolveChangelogDescription(undefined, "a", "b")).toThrow(/must match/);
  });

  test("rejects --summary conflicting with the positional (exit 4)", () => {
    expect(() => resolveChangelogDescription("pos", undefined, "other")).toThrow(/must match/);
  });

  test("add resolves the body from --summary and POSTs it as description", async () => {
    asPost().mockResolvedValue({ changelogId: 11 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t", "--summary", "body via summary"],
      { from: "user" }
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/changelog",
      expect.objectContaining({ description: "body via summary" }),
      expect.any(Object)
    );
  });

  test("update folds --summary into the description patch", async () => {
    asPut().mockResolvedValue({ changelogId: 11 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(
      ["changelog", "update", "11", "--summary", "new body"],
      { from: "user" }
    );
    expect(asPut()).toHaveBeenCalledWith(
      "/api/changelog/11",
      expect.objectContaining({ description: "new body" }),
      expect.any(Object)
    );
  });
});

describe("changelog list search / status / presence filters", () => {
  test("list maps --search to the search query param", async () => {
    const c = mockClient();
    c.get.mockResolvedValue([]);
    await runChangelogList(c as never, { search: "weather" });
    expect(c.get).toHaveBeenCalledWith("/api/changelog?search=weather");
  });

  test("list maps --status to the status query param (substring)", async () => {
    const c = mockClient();
    c.get.mockResolvedValue([]);
    await runChangelogList(c as never, { status: "Deployed" });
    expect(c.get).toHaveBeenCalledWith("/api/changelog?status=Deployed");
  });

  test("list maps --has-feedback / --has-sentry to presence flags", async () => {
    const c = mockClient();
    c.get.mockResolvedValue([]);
    await runChangelogList(c as never, { hasFeedback: true, hasSentry: true });
    expect(c.get).toHaveBeenCalledWith("/api/changelog?hasFeedback=1&hasSentry=1");
  });

  test("list omits presence flags when not set", async () => {
    const c = mockClient();
    c.get.mockResolvedValue([]);
    await runChangelogList(c as never, { search: "x", hasFeedback: false });
    expect(c.get).toHaveBeenCalledWith("/api/changelog?search=x");
  });
});

describe("changelog --commit alias for --sha (fb#210)", () => {
  test("resolveShaAlias resolves either flag and rejects a conflict", () => {
    expect(resolveShaAlias("abc", undefined)).toBe("abc");
    expect(resolveShaAlias(undefined, "abc")).toBe("abc");
    expect(resolveShaAlias(undefined, undefined)).toBeUndefined();
    expect(resolveShaAlias("abc", "abc")).toBe("abc");
    expect(() => resolveShaAlias("abc", "def")).toThrow(/alias for --sha/);
  });

  test("add accepts --commit and POSTs it as commitShas", async () => {
    asPost().mockResolvedValue({ changelogId: 12 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", "--commit", "88a04698"],
      { from: "user" }
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/changelog",
      expect.objectContaining({ commitShas: "88a04698" }),
      expect.any(Object)
    );
  });

  test("update folds --commit into the commitShas patch", async () => {
    asPut().mockResolvedValue({ changelogId: 12 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(
      ["changelog", "update", "12", "--commit", "9799cc6"],
      { from: "user" }
    );
    expect(asPut()).toHaveBeenCalledWith(
      "/api/changelog/12",
      expect.objectContaining({ commitShas: "9799cc6" }),
      expect.any(Object)
    );
  });

  test("the aliased value still hits the 500-char sha length cap (exit 4, no POST)", async () => {
    asPost().mockResolvedValue({ changelogId: 1 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await expect(program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", "--commit", "x".repeat(501)],
      { from: "user" }
    )).rejects.toMatchObject({ exitCode: 4 });
    expect(asPost()).not.toHaveBeenCalled();
  });
});

describe("changelog --unreleased routes to the pending queue (fb#196/197)", () => {
  test("list --unreleased GETs /api/changelog/pending (not the month list)", async () => {
    asGet().mockResolvedValue({ items: [], entries: [], maxBumpLevel: null, count: 0 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(["changelog", "list", "--unreleased"], { from: "user" });
    expect(asGet()).toHaveBeenCalledWith("/api/changelog/pending");
  });

  test("report --unreleased GETs /api/changelog/pending (no --month required)", async () => {
    asGet().mockResolvedValue({ items: [], entries: [], maxBumpLevel: null, count: 0 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(["changelog", "report", "--unreleased"], { from: "user" });
    expect(asGet()).toHaveBeenCalledWith("/api/changelog/pending");
  });

  test("report with neither --month nor --unreleased exits 4 without any fetch", async () => {
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const prevExit = process.exitCode;
    await program.parseAsync(["changelog", "report"], { from: "user" });
    expect(process.exitCode).toBe(4);
    expect(asGet()).not.toHaveBeenCalled();
    process.exitCode = prevExit;
  });
});

describe("readJsonInput BOM handling", () => {
  test("parses a JSON array file that has a UTF-8 BOM (PowerShell Out-File -Encoding utf8)", () => {
    const p = join(tmpdir(), "ib-map-bom-test.json");
    const payload = [{ changelogId: 7, versionTag: "puminet5api@0.62.13" }];
    writeFileSync(p, "\uFEFF" + JSON.stringify(payload), "utf8");
    try {
      expect(readJsonInput(p)).toEqual(payload);
    } finally {
      unlinkSync(p);
    }
  });
  test("parses a JSON array file with no BOM", () => {
    const p = join(tmpdir(), "ib-map-nobom-test.json");
    const payload = [{ changelogId: 8, versionTag: "puminet4@0.62.10" }];
    writeFileSync(p, JSON.stringify(payload), "utf8");
    try {
      expect(readJsonInput(p)).toEqual(payload);
    } finally {
      unlinkSync(p);
    }
  });
});
