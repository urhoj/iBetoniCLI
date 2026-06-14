import { describe, test, expect, vi, beforeEach } from "vitest";
import { runChangelogAdd, runChangelogList, runChangelogReport }
  from "../../src/commands/changelog/index.js";
import type { ApiClient } from "../../src/api/client.js";

const client = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() } as unknown as ApiClient;
const asPost = () => client.post as ReturnType<typeof vi.fn>;
const asGet = () => client.get as ReturnType<typeof vi.fn>;
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
