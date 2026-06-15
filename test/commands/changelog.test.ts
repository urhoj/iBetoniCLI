import { test, expect, vi, beforeEach } from "vitest";
import { runChangelogAdd, runChangelogList, runChangelogReport, runChangelogGet, runChangelogUpdate, normalizeSentryRef }
  from "../../src/commands/changelog/index.js";
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

test("add --dry-run never posts", async () => {
  const r = await runChangelogAdd(client,
    { type: "feature", area: "cli", title: "t", description: "d", entryDate: "2026-06-14" }, { dryRun: true });
  expect(r).toMatchObject({ dryRun: true });
  expect(asPost()).not.toHaveBeenCalled();
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
