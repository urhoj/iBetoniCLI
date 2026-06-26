import { test, expect, vi, beforeEach, describe } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChangelogAdd, runChangelogList, runChangelogReport, runChangelogGet, runChangelogUpdate, normalizeSentryRef, normalizeLanguage, readJsonInput, validateEnums }
  from "../../src/commands/changelog/index.js";
import type { ChangelogAddBody } from "../../src/commands/changelog/index.js";
import type { ApiClient } from "../../src/api/client.js";

const client = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() } as unknown as ApiClient;
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

import { runChangelogPending, runChangelogRelease, runChangelogReleaseMap } from "../../src/commands/changelog/index.js";

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
    expect(() => validateEnums(undefined, undefined, undefined, "xxx")).toThrow(/human\|routine/);
  });

  test("list --source routine maps to the source query param", async () => {
    const c = mockClient();
    c.get.mockResolvedValue([]);
    await runChangelogList(c as never, { source: "routine" });
    expect(c.get).toHaveBeenCalledWith("/api/changelog?source=routine");
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
