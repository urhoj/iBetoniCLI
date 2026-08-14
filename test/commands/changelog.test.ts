import { test, it, expect, vi, beforeEach, describe } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChangelogAdd, runChangelogList, runChangelogReport, runChangelogGet, runChangelogUpdate, runChangelogDelete, normalizeSentryRef, normalizeLanguage, normalizeType, normalizeSeverity, validateEnums, validateFieldLengths, resolveChangelogDescription, resolveShaAlias, CHANGELOG_SPECS, FIELD_MAX_LENGTHS }
  from "../../src/commands/changelog/index.js";
import { readJsonInput } from "../../src/api/parseBody.js";
import type { ChangelogAddBody } from "../../src/commands/changelog/index.js";
import { writeFlagsToHeaders } from "../../src/api/writeFlags.js";
import type { ValidationEnvelope } from "../../src/output/validationEnvelope.js";
import { intCsvFlag } from "../../src/targets.js";

const client = mockApiClient();

/**
 * Run a fn expected to throw and return the thrown value for structural
 * assertions. Typed off the real `ValidationEnvelope`/`FlagProblem` rather than
 * a hand-restated shape — the local copy had already drifted (no `remedy`, no
 * `issue`), which an untyped test/ tree could not surface (fb#487).
 */
function captureThrow(fn: () => void): { exitCode?: number; body?: Partial<ValidationEnvelope> } {
  try {
    fn();
  } catch (e) {
    return e as never;
  }
  throw new Error("expected fn to throw");
}

/**
 * Run a parse whose in-action guard fails, and return what the CALLER sees: the
 * JSON error envelope on stderr plus the mapped exit code. The guard's CliError
 * is caught by the action's `guarded` tail (same envelope/code `handleParse-
 * Rejection` would have produced for a throw outside it), so `parseAsync`
 * resolves instead of rejecting. `process.exitCode` is restored so a guard
 * assertion never leaks into the runner's own exit code.
 */
async function captureActionError(
  run: () => Promise<unknown>
): Promise<{ exitCode: number | undefined; envelope: Record<string, unknown> }> {
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  try {
    await run();
    return {
      exitCode: process.exitCode as number | undefined,
      envelope: JSON.parse(chunks.join("")) as Record<string, unknown>,
    };
  } finally {
    spy.mockRestore();
    process.exitCode = prevExit;
  }
}

const asPost = () => client.post;
const asGet = () => client.get;
const asPut = () => client.put;
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
  expect(client.delete).not.toHaveBeenCalled();
});

test("delete issues DELETE /api/changelog/:id with the write headers", async () => {
  const asDelete = client.delete;
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
  expect(() => normalizeLanguage("de")).toThrow(/--language must be one of: fi, en/);
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
  return mockApiClient({ post: vi.fn().mockResolvedValue({ changelogId: 1 }) });
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

import { runChangelogPending, runChangelogRelease, runChangelogReleaseMap, registerChangelogCommands, payloadKeyMap, normalizeChangelogJson, mergeChangelogInput, warnIfPatchIgnored, warnFeedbackLinkEffects } from "../../src/commands/changelog/index.js";
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

  // fb#330: the caps were documented only in a trailing NOTES line, so a payload
  // was written over-length, rejected, trimmed by estimate, and rejected again.
  // The help text is derived from the same map the validator uses, so the two
  // cannot drift — assert that, not the literal numbers.
  test("every bounded flag states its cap in its own spec description, matching the validator", () => {
    for (const command of ["ib dev changelog add", "ib dev changelog update"]) {
      const spec = CHANGELOG_SPECS.find((s) => s.command === command);
      expect(spec, `${command} spec missing`).toBeDefined();
      for (const [flag, cap] of Object.entries(FIELD_MAX_LENGTHS)) {
        const row = spec!.flags?.find((f) => f.name === flag);
        if (!row) continue; // not every bounded flag exists on both commands
        expect(row.description, `${command} --${flag}`).toContain(`max ${cap} chars`);
      }
    }
  });

  test("unbounded flags gain no cap text", () => {
    const spec = CHANGELOG_SPECS.find((s) => s.command === "ib dev changelog add")!;
    for (const flag of ["description", "benefits", "files"]) {
      const row = spec.flags?.find((f) => f.name === flag);
      if (row) expect(row.description).not.toMatch(/max \d+ chars/);
    }
  });

  // fb#305: a hintless failWith here inherited the command's FIRST client exit-4
  // row — the argv-mangling one — telling a caller already using --from-json to
  // use --from-json. The guard now carries its own hint naming the overflow.
  test("carries a positive hint naming the per-flag overflow, not the argv remedy", () => {
    const err = captureThrow(() => validateFieldLengths({ impact: "x".repeat(505) })) as unknown as {
      hint?: string;
    };
    expect(err.hint).toMatch(/--impact by 5\b/);
    expect(err.hint).not.toMatch(/instead of argv/i);
    // and it explicitly rules out the remedy that used to be served
    expect(err.hint).toMatch(/--from-json does not help/i);
  });

  test("the hint names every over-length flag with its own overflow", () => {
    const err = captureThrow(() =>
      validateFieldLengths({ status: "x".repeat(35), severity: "y".repeat(22) })
    ) as unknown as { hint?: string };
    expect(err.hint).toMatch(/--status by 5\b/);
    expect(err.hint).toMatch(/--severity by 2\b/);
  });

  test("checks --sha/--vtag which map to longer columns", () => {
    expect(() => validateFieldLengths({ sha: "a".repeat(500) })).not.toThrow();
    expect(() => validateFieldLengths({ sha: "a".repeat(501) })).toThrow(/--sha/);
    expect(() => validateFieldLengths({ vtag: "v".repeat(201) })).toThrow(/--vtag/);
  });

  test("add with an over-length --status exits 4 without POSTing (fb#206)", async () => {
    // validateFieldLengths runs (like validateEnums) before the request is
    // built, so the CliError surfaces as the exit-4 envelope — the POST is
    // never reached.
    asPost().mockResolvedValue({ changelogId: 1 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const { exitCode } = await captureActionError(() => program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", "--status", "x".repeat(40)],
      { from: "user" }
    ));
    expect(exitCode).toBe(4);
    expect(asPost()).not.toHaveBeenCalled();
  });
});

describe("changelog add --no-resolve (fb#441/fb#517)", () => {
  /** Run `changelog add` through the real Commander tree and return the POSTed body. */
  async function addWith(args: string[]): Promise<Record<string, unknown>> {
    asPost().mockResolvedValue({ changelogId: 1199 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", ...args],
      { from: "user" }
    );
    return asPost().mock.calls[0][1] as Record<string, unknown>;
  }

  test("sends resolveFeedback:false so the row keeps its status", async () => {
    // fb#576: --feedback is now CSV-typed, so even a single id arrives as
    // number[] — was toBe(416).
    const body = await addWith(["--feedback", "416", "--no-resolve"]);
    expect(body.feedbackId).toEqual([416]);
    expect(body.resolveFeedback).toBe(false);
  });

  test("omits the key entirely without the flag — Commander's `true` default must not ride along", async () => {
    // Sending resolveFeedback:true on every add would assert an intent the caller
    // never expressed, and the backend would have no way to tell a deliberate
    // resolve request from the flag's mere presence.
    const body = await addWith(["--feedback", "416"]);
    expect(body).not.toHaveProperty("resolveFeedback");
  });

  test("omits it on an add with no --feedback at all", async () => {
    const body = await addWith([]);
    expect(body).not.toHaveProperty("resolveFeedback");
    expect(body).not.toHaveProperty("feedbackId");
  });

  test("`resolve` is NOT an accepted --from-json key (fb#541)", () => {
    // Registering --no-resolve exposed Commander attribute `resolve`, which the
    // derived key map picked up for free. normalizeFromJson only accepts strings,
    // so the key was advertised and then unusable BOTH ways: `false` exited 4, and
    // `"false"` was accepted and silently dropped — force-applying the row anyway,
    // the exact fb#298 class this pipeline exists to prevent. Excluding it makes
    // the key a loud unknown instead. No capability lost: --no-resolve takes no
    // value, so it composes with --from-json on argv.
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const group = program.commands.find((c) => c.name() === "changelog")!;
    for (const leaf of ["add", "update"]) {
      const keys = payloadKeyMap(group.commands.find((c) => c.name() === leaf)!);
      expect([...keys.keys()]).not.toContain("resolve");
      expect([...keys.keys()]).not.toContain("no-resolve");
    }
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

describe("changelog --body alias for --description (fb#278)", () => {
  test("resolves --body alone", () => {
    expect(resolveChangelogDescription(undefined, undefined, undefined, "from body")).toBe("from body");
  });

  test("accepts --body agreeing with the positional / --description / --summary", () => {
    expect(resolveChangelogDescription("same", undefined, undefined, "same")).toBe("same");
    expect(resolveChangelogDescription(undefined, "same", undefined, "same")).toBe("same");
    expect(resolveChangelogDescription(undefined, undefined, "same", "same")).toBe("same");
  });

  test("rejects --body conflicting with any other source (exit 4)", () => {
    expect(() => resolveChangelogDescription("pos", undefined, undefined, "other")).toThrow(/must match/);
    expect(() => resolveChangelogDescription(undefined, "a", undefined, "b")).toThrow(/must match/);
    expect(() => resolveChangelogDescription(undefined, undefined, "a", "b")).toThrow(/must match/);
  });

  test("add resolves the body from --body and POSTs it as description", async () => {
    asPost().mockResolvedValue({ changelogId: 12 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    // Would exit 4 with `unknown option "--body"` before the fix.
    await program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t", "--body", "body via body"],
      { from: "user" }
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/changelog",
      expect.objectContaining({ description: "body via body" }),
      expect.any(Object)
    );
  });

  test("update folds --body into the description patch", async () => {
    asPut().mockResolvedValue({ changelogId: 12 });
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    await program.parseAsync(["changelog", "update", "12", "--body", "new body"], { from: "user" });
    expect(asPut()).toHaveBeenCalledWith(
      "/api/changelog/12",
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
    const { exitCode } = await captureActionError(() => program.parseAsync(
      ["changelog", "add", "--type", "bugfix", "--area", "cli", "--title", "t",
        "--description", "d", "--commit", "x".repeat(501)],
      { from: "user" }
    ));
    expect(exitCode).toBe(4);
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

// ─── fb#300: argv-safe entry input ──────────────────────────────────────────
// A changelog description is long-form prose ABOUT code, so it is the text most
// likely to contain double quotes — and PowerShell splits a native arg on those,
// so the CLI saw N positionals and exited 4. --from-json bypasses argv entirely.
describe("changelog add/update --from-json (fb#300)", () => {
  const withJsonFile = async (payload: unknown, fn: (path: string) => Promise<void>) => {
    const p = join(tmpdir(), `ib-changelog-fromjson-${process.pid}.json`);
    writeFileSync(p, JSON.stringify(payload), "utf8");
    try { await fn(p); } finally { unlinkSync(p); }
  };

  /** The payload key set `add` accepts, derived from its own registered flags. */
  const addKeyMap = (): Map<string, string> => {
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const add = program.commands
      .find((c) => c.name() === "changelog")!
      .commands.find((c) => c.name() === "add")!;
    return payloadKeyMap(add);
  };

  test("precedence is explicit flag > JSON > Commander default", () => {
    // The middle rung is the trap: --bump-level declares a default ("patch"), so
    // a naive "flags win" merge would let a default the caller never typed beat
    // the JSON value.
    expect(mergeChangelogInput({ bumpLevel: "minor" }, {}, { bumpLevel: "patch" }).bumpLevel).toBe("minor");
    expect(mergeChangelogInput({ bumpLevel: "minor" }, { bumpLevel: "major" }, { bumpLevel: "patch" }).bumpLevel).toBe("major");
    expect(mergeChangelogInput({}, {}, { bumpLevel: "patch" }).bumpLevel).toBe("patch");
    expect(mergeChangelogInput({ title: "t", type: "bugfix" }, {}, {})).toMatchObject({ title: "t", type: "bugfix" });
  });

  test("the key map is derived from each command's own flags", () => {
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const group = program.commands.find((c) => c.name() === "changelog")!;
    const add = payloadKeyMap(group.commands.find((c) => c.name() === "add")!);
    const update = payloadKeyMap(group.commands.find((c) => c.name() === "update")!);
    // Both spellings of a hyphenated flag resolve to the camelCase attribute.
    expect(add.get("bumpLevel")).toBe("bumpLevel");
    expect(add.get("bump-level")).toBe("bumpLevel");
    // fb#303: update carries them too now — they were unreachable there, which
    // made a mis-set --bump-level (it drives the deploy version bump) permanent.
    expect(update.get("bumpLevel")).toBe("bumpLevel");
    expect(update.get("bump-level")).toBe("bumpLevel");
    expect(update.get("feedback")).toBe("feedback");
    expect(update.get("sentry")).toBe("sentry");
    // `add` still has genuinely add-only keys the update command cannot apply.
    expect(update.has("date")).toBe(true);
    // Write-safety flags and the JSON source itself are never payload fields.
    for (const k of ["dryRun", "reason", "idempotencyKey", "fromJson"]) expect(add.has(k)).toBe(false);
  });

  test("an unknown key exits 4 and lists the accepted keys (never silently dropped)", () => {
    // fb#298 was exactly a silently-ignored JSON key destroying a stored value;
    // a changelog entry is the permanent record the monthly report is built from.
    // `changelogId` is the read shape's PRIMARY KEY: it comes back on every row
    // yet is not writable, so it proves the fb#357 read-shape aliases are a
    // curated table and not "accept whatever `changelog list` emits".
    const err = captureThrow(() => normalizeChangelogJson({ changelogId: 1049 }, addKeyMap()));
    expect(err.exitCode).toBe(4);
    expect((err as unknown as Error).message).toMatch(/unknown key changelogId/);
    expect((err as unknown as Error).message).toMatch(/accepted: /);
  });

  test("the read-shape spelling of a writable field is accepted (fb#357)", () => {
    // The twin of the case above, and the reason it changed: `versionTag` used
    // to be rejected here, which is what broke read-a-row → edit → post-it-back.
    expect(normalizeChangelogJson({ versionTag: "1.2.3" }, addKeyMap())).toEqual({ vtag: "1.2.3" });
  });

  test("wrong-typed values are rejected by name instead of crashing downstream", () => {
    // `files: {...}` would otherwise reach o.files.split(",") as a raw TypeError.
    const err = captureThrow(() => normalizeChangelogJson({ title: 5, files: { a: 1 } }, addKeyMap()));
    expect(err.exitCode).toBe(4);
    expect((err as unknown as Error).message).toMatch(/"title" must be a string/);
    expect((err as unknown as Error).message).toMatch(/"files" must be a string or an array of strings/);
  });

  test("CSV fields accept an array (what a JSON author naturally writes)", () => {
    expect(normalizeChangelogJson({ files: ["a.ts", " b.ts "], repo: ["betonicli"] }, addKeyMap()))
      .toEqual({ files: "a.ts,b.ts", repo: "betonicli" });
  });

  test("a quote-bearing entry round-trips, and JSON supplies the required trio", async () => {
    asPost().mockResolvedValue({ changelogId: 300 });
    const description =
      'the entry failed with "too many arguments for \'add\'. Expected 1 argument but got 3: many, arguments."';
    await withJsonFile(
      {
        type: "improvement", area: "cli", title: 'argv-safe "changelog add"',
        description, repo: "betonicli", bumpLevel: "none", feedback: 300,
        files: ["src/commands/changelog/index.ts"], date: "2026-08-05",
      },
      async (p) => {
        const program = new Command();
        registerChangelogCommands(program, async () => client);
        await program.parseAsync(["changelog", "add", "--from-json", p], { from: "user" });
      }
    );
    expect(asPost()).toHaveBeenCalledWith(
      "/api/changelog",
      {
        type: "improvement", area: "cli", title: 'argv-safe "changelog add"',
        description, entryDate: "2026-08-05", repo: "betonicli",
        files: JSON.stringify(["src/commands/changelog/index.ts"]),
        // fb#576: --feedback is now CSV-typed, so even a JSON-supplied bare
        // number is normalized to number[] — was feedbackId: 300.
        feedbackId: [300], bumpLevel: "none",
      },
      { headers: {} }
    );
  });

  test("an explicit flag overrides the JSON key", async () => {
    asPost().mockResolvedValue({ changelogId: 301 });
    await withJsonFile({ type: "bugfix", area: "cli", title: "t", description: "d", bumpLevel: "none" }, async (p) => {
      const program = new Command();
      registerChangelogCommands(program, async () => client);
      await program.parseAsync(
        ["changelog", "add", "--from-json", p, "--bump-level", "minor", "--title", "flag wins"],
        { from: "user" }
      );
    });
    expect(asPost().mock.calls[0][1]).toMatchObject({ bumpLevel: "minor", title: "flag wins", description: "d" });
  });

  test("a --from-json title/summary still feeds the description resolver", async () => {
    asPost().mockResolvedValue({ changelogId: 302 });
    await withJsonFile({ type: "feature", area: "cli", title: "t", summary: "body via summary" }, async (p) => {
      const program = new Command();
      registerChangelogCommands(program, async () => client);
      await program.parseAsync(["changelog", "add", "--from-json", p], { from: "user" });
    });
    expect(asPost().mock.calls[0][1]).toMatchObject({ description: "body via summary" });
  });

  test("a missing --from-json file exits 4 without POSTing", async () => {
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const { exitCode } = await captureActionError(() => program.parseAsync(
      ["changelog", "add", "--from-json", join(tmpdir(), "ib-does-not-exist-300.json")],
      { from: "user" }
    ));
    expect(exitCode).toBe(4);
    expect(asPost()).not.toHaveBeenCalled();
  });

  test("the required trio is enforced post-merge, aggregated with the description", async () => {
    // --type/--area/--title are plain options now (a .requiredOption fires before
    // any action, which would make --from-json unusable) — the guard moved into
    // the action and must keep the fb#204 prescriptive envelope.
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    const { exitCode, envelope } = await captureActionError(() =>
      program.parseAsync(["changelog", "add", "--repo", "betonicli"], { from: "user" })
    );
    expect(exitCode).toBe(4);
    const problems = envelope.problems as Array<{ flag: string; allowed?: string[] }>;
    expect(problems.map((p) => p.flag)).toEqual(["--type", "--area", "--title", "--description"]);
    expect(problems[0].allowed).toEqual(["feature", "improvement", "bugfix"]);
    expect(String(envelope.sample)).toContain("ib dev changelog add");
    expect(asPost()).not.toHaveBeenCalled();
  });

  test("update takes a --from-json patch under its explicit flags", async () => {
    asPut().mockResolvedValue({ changelogId: 386 });
    await withJsonFile({ status: 'Deployed "prod"', description: "corrected prose" }, async (p) => {
      const program = new Command();
      registerChangelogCommands(program, async () => client);
      await program.parseAsync(["changelog", "update", "386", "--from-json", p, "--status", "Deployed"], { from: "user" });
    });
    expect(asPut()).toHaveBeenCalledWith(
      "/api/changelog/386",
      { description: "corrected prose", status: "Deployed" },
      expect.any(Object)
    );
  });

  test("an unknown key in an update payload exits 4 without PUTting", async () => {
    // The key map is derived per-command, so a key no flag backs is rejected
    // rather than silently dropped (fb#298) — checked here through the real
    // parse, not just normalizeChangelogJson, so nothing reaches the PUT.
    // (Was `entryDate`, which fb#357 made a legitimate alias for --date.)
    await withJsonFile({ changelogId: 386 }, async (p) => {
      const program = new Command();
      registerChangelogCommands(program, async () => client);
      const { exitCode } = await captureActionError(() =>
        program.parseAsync(["changelog", "update", "386", "--from-json", p], { from: "user" })
      );
      expect(exitCode).toBe(4);
    });
    expect(asPut()).not.toHaveBeenCalled();
  });

  test("update accepts bumpLevel from --from-json (fb#303)", async () => {
    asPut().mockResolvedValue({ changelogId: 386, bumpLevel: "none" });
    await withJsonFile({ bumpLevel: "none" }, async (p) => {
      const program = new Command();
      registerChangelogCommands(program, async () => client);
      await program.parseAsync(["changelog", "update", "386", "--from-json", p], { from: "user" });
    });
    expect(asPut()).toHaveBeenCalledWith("/api/changelog/386", { bumpLevel: "none" }, expect.any(Object));
  });
});

describe("changelog update — bumpLevel/feedback/sentry (fb#303)", () => {
  const parse = (argv: string[]) => {
    const program = new Command();
    registerChangelogCommands(program, async () => client);
    return program.parseAsync(["changelog", "update", ...argv], { from: "user" });
  };

  test("--bump-level reaches the patch", async () => {
    asPut().mockResolvedValue({ changelogId: 386, bumpLevel: "none" });
    await parse(["386", "--bump-level", "none"]);
    expect(asPut()).toHaveBeenCalledWith("/api/changelog/386", { bumpLevel: "none" }, expect.any(Object));
  });

  test("--bump-level has NO default — an unrelated patch leaves the level untouched", async () => {
    // The trap this guards: `add`'s --bump-level defaults to "patch". Copying
    // that default onto `update` would make every `update --status …` silently
    // rewrite a deliberate `minor` and mis-drive the next deploy.
    asPut().mockResolvedValue({ changelogId: 386 });
    await parse(["386", "--status", "Deployed"]);
    expect(asPut()).toHaveBeenCalledWith("/api/changelog/386", { status: "Deployed" }, expect.any(Object));
  });

  test("an invalid --bump-level exits 4 before any PUT", async () => {
    const { exitCode } = await captureActionError(() => parse(["386", "--bump-level", "huge"]));
    expect(exitCode).toBe(4);
    expect(asPut()).not.toHaveBeenCalled();
  });

  test("--feedback and --sentry reach the patch, the Sentry ref normalized", async () => {
    asPut().mockResolvedValue({ changelogId: 386, feedbackId: 303 });
    await parse(["386", "--feedback", "303", "--sentry", "https://x.sentry.io/issues/PUMINET5API-1A2/"]);
    // fb#576: --feedback is now CSV-typed, so even a single id arrives as
    // number[] — was feedbackId: 303.
    expect(asPut()).toHaveBeenCalledWith(
      "/api/changelog/386",
      { feedbackId: [303], sentryIssue: "PUMINET5API-1A2" },
      expect.any(Object)
    );
  });
});

describe("warnIfPatchIgnored — deploy gate (fb#303)", () => {
  test("warns when the backend echoes a deploy-gated field unchanged", () => {
    // The old backend's PUT succeeds and returns the row with the OLD value —
    // no error, no clue. That silent drop is what fb#303 was filed about.
    const warn = vi.fn();
    warnIfPatchIgnored({ bumpLevel: "none" }, { changelogId: 7, bumpLevel: "patch" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/--bump-level/);
    expect(warn.mock.calls[0][0]).toMatch(/fb#303/);
  });

  test("stays silent when the echo matches", () => {
    const warn = vi.fn();
    warnIfPatchIgnored({ bumpLevel: "none" }, { changelogId: 7, bumpLevel: "none" }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent under --dry-run and on a non-row result", () => {
    const warn = vi.fn();
    warnIfPatchIgnored({ bumpLevel: "none" }, { dryRun: true, wouldUpdate: {} }, warn);
    warnIfPatchIgnored({ bumpLevel: "none" }, null, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  test("ignores fields absent from the echoed row rather than crying wolf", () => {
    const warn = vi.fn();
    warnIfPatchIgnored({ bumpLevel: "none" }, { changelogId: 7 }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  test("names every ignored field at once", () => {
    const warn = vi.fn();
    warnIfPatchIgnored(
      { bumpLevel: "none", feedbackId: 303, sentryIssue: "X-1" },
      { changelogId: 7, bumpLevel: "patch", feedbackId: null, sentryIssue: null },
      warn
    );
    expect(warn.mock.calls[0][0]).toMatch(/--bump-level/);
    expect(warn.mock.calls[0][0]).toMatch(/--feedback/);
    expect(warn.mock.calls[0][0]).toMatch(/--sentry/);
  });
});

describe("warnFeedbackLinkEffects — silent link theft (fb#366)", () => {
  test("warns when the entry took the link from a different entry", () => {
    // The reported case: fb#362 was fixed by cl#1054, then a follow-up entry
    // passed --feedback 362 to cross-reference it and silently became the
    // row's resolver. Anyone following the feedback row afterwards lands on
    // the follow-up instead of the fix.
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1062, relinkedFrom: 1054 }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/cl#1054/);
    expect(warn.mock.calls[0][0]).toMatch(/cl#1062/);
    // The note must carry the recovery command, not just the bad news —
    // the loss is only reachable if you knew the link changed.
    expect(warn.mock.calls[0][0]).toMatch(/changelog update 1054 --feedback/);
  });

  test("stays silent on a first resolve, which is the overwhelmingly common case", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1062 }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent under --dry-run and on a non-object result", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ dryRun: true, wouldCreate: {} }, warn);
    warnFeedbackLinkEffects(null, warn);
    warnFeedbackLinkEffects("nope", warn);
    expect(warn).not.toHaveBeenCalled();
  });

  test("ignores a non-numeric relinkedFrom rather than printing 'cl#undefined'", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1062, relinkedFrom: null }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("warnFeedbackLinkEffects — the link did not close the row (fb#517/fb#441)", () => {
  test("says so when the row was left at a preserved status", () => {
    // The reported case: fb#446 was a BETONIJERRY_TOS amendment deliberately set
    // to `reviewed` (draft saved, awaiting activation). The entry recording the
    // drafting work flipped it to `applied` — claiming shipped-to-production for
    // a document still status=draft that no user had ever seen.
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1208, feedbackStatus: "reviewed" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/left at `reviewed`/);
    expect(warn.mock.calls[0][0]).toMatch(/NOT marked applied/);
    // Must carry the way to close it, so the row is not simply forgotten.
    expect(warn.mock.calls[0][0]).toMatch(/feedback resolve <id> --status applied/);
  });

  test("stays silent when the row did become applied — the common path", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1054 }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  test("reports both effects when a relink ALSO failed to close the row", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects(
      { changelogId: 1199, relinkedFrom: 1054, feedbackStatus: "open" },
      warn
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("warns loudly when --feedback named an id that does not exist (fb#543)", () => {
    // The entry IS created, so the response looks like success; without this a
    // typo'd id left the caller believing the row was closed while it stayed open.
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1300, feedbackLinked: false }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/does not exist/);
    expect(warn.mock.calls[0][0]).toMatch(/NOTHING was linked/);
    // Must carry the repair, naming the entry that was actually created.
    expect(warn.mock.calls[0][0]).toMatch(/changelog update 1300 --feedback/);
  });

  test("stays silent when feedbackLinked is absent — the normal success shape", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1300 }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

// fb#548 — the mirror of the fb#366 relink note. --no-resolve used to suppress
// the STATUS change but take the LINK anyway, so cross-referencing a follow-up
// onto another session's already-shipped fix stole its credit and reported
// `relinkedFrom`. The backend now leaves the link put and echoes `linkKeptBy`.
describe("warnFeedbackLinkEffects — the link stayed with its owner (fb#548)", () => {
  test("says the link did NOT move, and does not send the caller off to restore it", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1284, linkKeptBy: 1276 }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toMatch(/still resolved by cl#1276/);
    expect(msg).toMatch(/cross-reference only/);
    expect(msg).toMatch(/Nothing to restore/);
    // Must NOT read as the fb#366 relink note — that would have the caller
    // "repair" a link that never moved, swapping the problem back and forth.
    expect(msg).not.toMatch(/now owns the link/);
  });

  test("offers the way to become the resolver, for a caller who did mean to take it", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1284, linkKeptBy: 1276 }, warn);
    expect(warn.mock.calls[0][0]).toMatch(/changelog update 1284 --feedback/);
  });

  test("relinkedFrom and linkKeptBy are mutually exclusive in practice, but both render", () => {
    // The backend emits exactly one; assert the renderer keeps them distinct
    // rather than collapsing to whichever it checks first.
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1284, relinkedFrom: 1276 }, warn);
    expect(warn.mock.calls[0][0]).toMatch(/now owns the link/);
    warn.mockClear();
    warnFeedbackLinkEffects({ changelogId: 1284, linkKeptBy: 1276 }, warn);
    expect(warn.mock.calls[0][0]).toMatch(/still resolved by/);
  });

  test("ignores a non-numeric linkKeptBy rather than printing 'cl#undefined'", () => {
    const warn = vi.fn();
    warnFeedbackLinkEffects({ changelogId: 1284, linkKeptBy: null }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("normalizeSeverity — one flag name, two different ladders (fb#359)", () => {
  test("passes the canonical Finnish urgency values through", () => {
    for (const v of ["Kriittinen", "Korkea", "Normaali", "Matala"]) {
      expect(normalizeSeverity(v)).toBe(v);
    }
  });

  test("maps the English urgency words a caller reaches for", () => {
    expect(normalizeSeverity("critical")).toBe("Kriittinen");
    expect(normalizeSeverity("high")).toBe("Korkea");
    expect(normalizeSeverity("normal")).toBe("Normaali");
    expect(normalizeSeverity("low")).toBe("Matala");
  });

  test("maps the sibling feedback IMPACT enum onto the urgency ladder", () => {
    // The reported failure exactly: one session writing up a single fix touches
    // both commands, so the value in hand is whichever the other one took.
    expect(normalizeSeverity("major")).toBe("Korkea");
    expect(normalizeSeverity("minor")).toBe("Matala");
    expect(normalizeSeverity("cosmetic")).toBe("Matala");
  });

  test("trims and is case-insensitive", () => {
    expect(normalizeSeverity("  KORKEA ")).toBe("Korkea");
    expect(normalizeSeverity("Normal")).toBe("Normaali");
  });

  test("undefined and blank stay unset rather than becoming a value", () => {
    expect(normalizeSeverity(undefined)).toBeUndefined();
    expect(normalizeSeverity("   ")).toBeUndefined();
  });

  test("passes an unknown value through for validateEnums to reject (exit 4)", () => {
    // Was free text capped at 20 chars: a typo landed in the permanent record.
    // The rejection channel is validateEnums so --severity gets the same
    // structured problems[] envelope as --type (allowed + synonyms fields).
    expect(normalizeSeverity("Korkeaa")).toBe("Korkeaa");
    const err = captureThrow(() =>
      validateEnums(undefined, undefined, undefined, undefined, normalizeSeverity("Korkeaa"))
    );
    expect(err.exitCode).toBe(4);
  });

  test("the rejection carries both ladders as machine fields, so the caller does not re-guess", () => {
    const err = captureThrow(() =>
      validateEnums(undefined, undefined, undefined, undefined, "blah")
    );
    const body = err.body as { problems: Array<{ flag: string; allowed?: string[]; synonyms?: Record<string, string>; remedy?: string }> };
    const p = body.problems.find((x) => x.flag === "--severity")!;
    expect(p.allowed).toEqual(["Kriittinen", "Korkea", "Normaali", "Matala"]);
    expect(p.synonyms?.critical).toBe("Kriittinen");
    expect(p.remedy).toMatch(/ib dev feedback --severity/);
  });

  test("the mapped synonym then passes validateEnums", () => {
    expect(() =>
      validateEnums(undefined, undefined, undefined, undefined, normalizeSeverity("critical"))
    ).not.toThrow();
  });
});

describe("payloadKeyMap accepts the READ shape as input (fb#357)", () => {
  /** `add`'s key map, built the same way the other --from-json tests do. */
  const addKeys = (): Map<string, string> => {
    const program = new Command();
    registerChangelogCommands(program, async () => mockClient() as never);
    const add = program.commands
      .find((c) => c.name() === "changelog")!
      .commands.find((c) => c.name() === "add")!;
    return payloadKeyMap(add);
  };

  test("every read-shape column name resolves to its write flag", () => {
    const keys = addKeys();
    // The five names that differ between what `changelog list` EMITS and what
    // `add --from-json` accepted — the round-trip that used to exit 4.
    expect(keys.get("commitShas")).toBe("sha");
    expect(keys.get("versionTag")).toBe("vtag");
    expect(keys.get("feedbackId")).toBe("feedback");
    expect(keys.get("sentryIssue")).toBe("sentry");
    expect(keys.get("entryDate")).toBe("date");
  });

  test("the canonical spellings still resolve unchanged", () => {
    const keys = addKeys();
    expect(keys.get("sha")).toBe("sha");
    expect(keys.get("bumpLevel")).toBe("bumpLevel");
    expect(keys.get("bump-level")).toBe("bumpLevel");
  });

  test("a read row round-trips through normalizeChangelogJson", () => {
    // The actual reported workflow: template the JSON off a row you just read.
    const row = {
      title: "t", type: "bugfix", area: "cli",
      commitShas: "abc123", versionTag: "betonicli@1.1.12",
      feedbackId: 357, sentryIssue: "IB-1", entryDate: "2026-08-07",
    };
    const out = normalizeChangelogJson(row, addKeys());
    // fb#576: --feedback is now CSV-typed (a single id or several), so this
    // layer normalizes a numeric feedbackId column to its CSV-STRING form —
    // same as sha/vtag above — and the action parses it into number[] downstream
    // (see normalizeFeedbackIds), same as an explicit --feedback flag would be.
    expect(out).toMatchObject({
      sha: "abc123", vtag: "betonicli@1.1.12",
      feedback: "357", sentry: "IB-1", date: "2026-08-07",
    });
  });

  test("the accepted-key list stays the FLAG names, not the read aliases", () => {
    // Aliases are map KEYS, never values — the unknown-key error enumerates
    // values, so it must not start advertising commitShas as a writable name.
    const accepted = new Set(addKeys().values());
    expect(accepted.has("sha")).toBe(true);
    expect(accepted.has("commitShas")).toBe(false);
    expect(accepted.has("versionTag")).toBe(false);
  });

  test("update only accepts read keys whose flag it actually registers", () => {
    const program = new Command();
    registerChangelogCommands(program, async () => mockClient() as never);
    const group = program.commands.find((c) => c.name() === "changelog")!;
    const update = payloadKeyMap(group.commands.find((c) => c.name() === "update")!);
    // update has --sha/--vtag, so their read spellings map; it has no --date,
    // so entryDate must NOT resolve to a flag update cannot apply.
    expect(update.get("commitShas")).toBe("sha");
    expect(update.has("entryDate")).toBe(update.has("date"));
  });
});

/**
 * fb#576: --feedback became multi-valued, so every per-link warning has to name
 * the id it belongs to — otherwise three links produce three unattributable
 * notes and the caller cannot tell which row was relinked.
 */
describe("intCsvFlag", () => {
  it("parses a single id", () => {
    expect(intCsvFlag("--feedback")("541")).toEqual([541]);
  });
  it("parses a CSV in order", () => {
    expect(intCsvFlag("--feedback")("541,542,544")).toEqual([541, 542, 544]);
  });
  it("tolerates whitespace", () => {
    expect(intCsvFlag("--feedback")(" 541 , 542 ")).toEqual([541, 542]);
  });
  it("strips an fb# anchor per element, so the house style keeps working", () => {
    expect(intCsvFlag("--feedback")("fb#541,542")).toEqual([541, 542]);
  });
  it("exits 4 on a malformed element rather than dropping it", () => {
    expect(() => intCsvFlag("--feedback")("541,abc")).toThrow(/must be an integer/);
  });
  it("exits 4 on a cl# anchor — the wrong ref type", () => {
    expect(() => intCsvFlag("--feedback")("cl#1281")).toThrow();
  });
});

describe("warnFeedbackLinkEffects — per-id", () => {
  it("prefixes each note with its feedback id, in input order", () => {
    const msgs: string[] = [];
    warnFeedbackLinkEffects(
      {
        changelogId: 1281,
        feedbackLinks: [
          { feedbackId: 541, role: "resolves" },
          { feedbackId: 542, role: "resolves", relinkedFrom: 1054 },
          { feedbackId: 544, feedbackLinked: false },
        ],
      },
      (m) => msgs.push(m)
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("fb#542");
    expect(msgs[0]).toContain("cl#1054");
    expect(msgs[1]).toContain("fb#544");
    expect(msgs[1]).toContain("NOTHING was linked");
  });

  it("reports linkKeptBy per id under --no-resolve", () => {
    const msgs: string[] = [];
    warnFeedbackLinkEffects(
      { changelogId: 1284, feedbackLinks: [{ feedbackId: 539, role: "references", linkKeptBy: 1276 }] },
      (m) => msgs.push(m)
    );
    expect(msgs[0]).toContain("fb#539");
    expect(msgs[0]).toContain("cl#1276");
  });

  it("still reads the legacy top-level shape, so an older backend keeps warning", () => {
    const msgs: string[] = [];
    warnFeedbackLinkEffects({ changelogId: 1062, relinkedFrom: 1054 }, (m) => msgs.push(m));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("cl#1054");
  });

  it("says nothing on a clean multi-link", () => {
    const msgs: string[] = [];
    warnFeedbackLinkEffects(
      { changelogId: 1281, feedbackLinks: [{ feedbackId: 541, role: "resolves" }] },
      (m) => msgs.push(m)
    );
    expect(msgs).toHaveLength(0);
  });
});
