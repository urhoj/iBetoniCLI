import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  runFeedbackCreate,
  runFeedbackList,
  runFeedbackGet,
  runFeedbackResolve,
  mergeNoteFlags,
  runFeedbackUpdate,
  runFeedbackCount,
  resolveFeedbackCreateDescription,
  registerFeedbackCommands,
} from "../../src/commands/feedback/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const post = mockClient.post as ReturnType<typeof vi.fn>;
const get = mockClient.get as ReturnType<typeof vi.fn>;
const put = mockClient.put as ReturnType<typeof vi.fn>;

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  put.mockReset();
});

// ─── create ──────────────────────────────────────────────────────────────────

describe("ib feedback create", () => {
  test("accepts the description either positionally or via --description", () => {
    expect(resolveFeedbackCreateDescription({ description: "  a  " })).toBe("a");
    expect(resolveFeedbackCreateDescription({ descriptionFlag: "  b  " })).toBe("b");
    expect(
      resolveFeedbackCreateDescription({ description: "same", descriptionFlag: " same " })
    ).toBe("same");
    expect(() =>
      resolveFeedbackCreateDescription({ description: "one", descriptionFlag: "two" })
    ).toThrowError(/--description/);
  });

  test("POSTs /api/feedback with kind+description as a META request (read-only exempt)", async () => {
    post.mockResolvedValueOnce({ feedbackId: 7 });
    const out = await runFeedbackCreate(mockClient, {
      description: "  schema output should include row counts  ",
    });
    expect(post).toHaveBeenCalledWith(
      "/api/feedback",
      { kind: "improvement", scope: "cli", description: "schema output should include row counts" },
      { meta: true }
    );
    expect(out).toEqual({ feedbackId: 7 });
  });

  test("includes command/error and honours --kind bug", async () => {
    post.mockResolvedValueOnce({ feedbackId: 8 });
    await runFeedbackCreate(mockClient, {
      description: "date rejected",
      kind: "bug",
      command: "keikka list --pvm 1.6.",
      error: "invalid date format",
    });
    expect(post).toHaveBeenCalledWith(
      "/api/feedback",
      {
        kind: "bug",
        scope: "cli",
        description: "date rejected",
        command: "keikka list --pvm 1.6.",
        error: "invalid date format",
      },
      { meta: true }
    );
  });

  test("an unknown --kind falls back to improvement", async () => {
    post.mockResolvedValueOnce({ feedbackId: 9 });
    await runFeedbackCreate(mockClient, { description: "x", kind: "nonsense" });
    expect(post.mock.calls[0][1]).toMatchObject({ kind: "improvement" });
  });

  test("--kind idea is accepted, not coerced", async () => {
    post.mockResolvedValueOnce({ feedbackId: 10 });
    await runFeedbackCreate(mockClient, { description: "ib customer search --email", kind: "idea" });
    expect(post.mock.calls[0][1]).toMatchObject({ kind: "idea" });
  });

  test("--kind legal is accepted, not coerced", async () => {
    post.mockResolvedValueOnce({ feedbackId: 11 });
    await runFeedbackCreate(mockClient, { description: "TOS lacks AI clause", kind: "legal" });
    expect(post.mock.calls[0][1]).toMatchObject({ kind: "legal" });
  });

  test("defaults scope to cli", async () => {
    post.mockResolvedValueOnce({ feedbackId: 9 });
    await runFeedbackCreate(mockClient, { description: "x" });
    expect(post.mock.calls[0][1]).toMatchObject({ scope: "cli" });
  });

  test.each(["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "other"])(
    "--scope %s is accepted and forwarded",
    async (scope) => {
      post.mockResolvedValueOnce({ feedbackId: 1 });
      await runFeedbackCreate(mockClient, { description: "x", scope });
      expect(post.mock.calls[0][1]).toMatchObject({ scope });
    }
  );

  test("unknown --scope exits 4 (strict, unlike --kind)", async () => {
    await expect(
      runFeedbackCreate(mockClient, { description: "x", scope: "nonsense" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  test("--dry-run prints the payload and never POSTs", async () => {
    const out = await runFeedbackCreate(mockClient, {
      description: "preview me",
      dryRun: true,
    });
    expect(post).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: {
        method: "POST",
        path: "/api/feedback",
        body: { kind: "improvement", scope: "cli", description: "preview me" },
      },
    });
  });

  test("empty description is a validation error (exit 4), no POST", async () => {
    await expect(runFeedbackCreate(mockClient, { description: "   " })).rejects.toThrowError(
      CliError
    );
    expect(post).not.toHaveBeenCalled();
  });

  test("create threads a valid severity into the body and rejects an unknown one", async () => {
    post.mockResolvedValue({ feedbackId: 1 });
    await runFeedbackCreate(mockClient, { description: "d", kind: "bug", severity: "major" });
    expect(post).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({ severity: "major", kind: "bug" }),
      { meta: true }
    );
    await expect(
      runFeedbackCreate(mockClient, { description: "d", severity: "sev1" })
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  test("create threads a valid complexity into the body", async () => {
    post.mockResolvedValueOnce({ feedbackId: 1 });
    await runFeedbackCreate(mockClient, { description: "d", complexity: 3 });
    expect(post.mock.calls[0][1]).toMatchObject({ complexity: 3 });
  });

  test.each([0, 6, 2.5, NaN])(
    "create rejects out-of-range complexity %s (exit 4), no POST",
    async (complexity) => {
      await expect(
        runFeedbackCreate(mockClient, { description: "d", complexity })
      ).rejects.toMatchObject({ exitCode: 4 });
      expect(post).not.toHaveBeenCalled();
    }
  );
});

// ─── /ai conversation provenance ─────────────────────────────────────────────

describe("ib feedback create — /ai conversation provenance", () => {
  const prev = process.env.IB_CONVERSATION_ID;
  afterEach(() => {
    if (prev === undefined) delete process.env.IB_CONVERSATION_ID;
    else process.env.IB_CONVERSATION_ID = prev;
  });

  test("folds IB_CONVERSATION_ID into context.conversationId", async () => {
    process.env.IB_CONVERSATION_ID = "4321";
    post.mockResolvedValueOnce({ feedbackId: 1 });
    await runFeedbackCreate(mockClient, { description: "grid crash", kind: "bug" });
    expect(post.mock.calls[0][1]).toMatchObject({
      kind: "bug",
      description: "grid crash",
      context: { conversationId: 4321 },
    });
  });

  test("omits context when IB_CONVERSATION_ID is unset", async () => {
    delete process.env.IB_CONVERSATION_ID;
    post.mockResolvedValueOnce({ feedbackId: 2 });
    await runFeedbackCreate(mockClient, { description: "x" });
    expect(post.mock.calls[0][1]).not.toHaveProperty("context");
  });

  test.each(["abc", "0", "-1", "4.5", ""])(
    "omits context when IB_CONVERSATION_ID is %s",
    async (val) => {
      process.env.IB_CONVERSATION_ID = val;
      post.mockResolvedValueOnce({ feedbackId: 3 });
      await runFeedbackCreate(mockClient, { description: "x" });
      expect(post.mock.calls[0][1]).not.toHaveProperty("context");
    }
  );

  test("--dry-run includes context in wouldSend.body", async () => {
    process.env.IB_CONVERSATION_ID = "9";
    const out = await runFeedbackCreate(mockClient, { description: "x", dryRun: true });
    expect(out).toMatchObject({ wouldSend: { body: { context: { conversationId: 9 } } } });
    expect(post).not.toHaveBeenCalled();
  });
});

// ─── list ──────────────────────────────────────────────────────────────────

describe("ib feedback list", () => {
  test("GETs with query filters and projects to the list envelope", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 1 }, { feedbackId: 2 }]);
    const out = await runFeedbackList(mockClient, { status: "open", kind: "bug", limit: 20 });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&kind=bug&limit=20");
    expect(out).toEqual({
      items: [{ feedbackId: 1 }, { feedbackId: 2 }],
      nextCursor: null,
      count: 2,
    });
  });

  test("no filters → defaults to the active bucket (open+reviewed), newest-first", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 3, status: "open" }]); // open page
    get.mockResolvedValueOnce([{ feedbackId: 5, status: "reviewed" }]); // reviewed page
    const out = await runFeedbackList(mockClient, {});
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&limit=200");
    expect(out.items.map((r) => r.feedbackId)).toEqual([5, 3]);
  });

  test("--all → bare path (every status), empty array tolerated", async () => {
    get.mockResolvedValueOnce(null);
    const out = await runFeedbackList(mockClient, { all: true });
    expect(get).toHaveBeenCalledWith("/api/feedback");
    expect(out).toEqual({ items: [], nextCursor: null, count: 0 });
  });

  test("forwards --scope filter to each default-bucket page", async () => {
    get.mockResolvedValueOnce([]);
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { scope: "workspace" });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&scope=workspace&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&scope=workspace&limit=200");
  });

  test("forwards --search on the single-status path", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", search: "IDOR" });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&search=IDOR");
  });

  test("forwards --max-complexity to each default-bucket page", async () => {
    get.mockResolvedValueOnce([]);
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { maxComplexity: 3 });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&maxComplexity=3&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&maxComplexity=3&limit=200");
  });

  test("forwards exact --complexity on the single-status path", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", complexity: 5 });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&complexity=5");
  });

  test("--oldest sets createdAt ASC ordering on the single-status path", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", oldest: true });
    expect(get).toHaveBeenCalledWith(
      "/api/feedback?status=open&orderBy=createdAt&orderDirection=ASC"
    );
  });

  test("without --oldest no ordering params are sent (backend default newest-first)", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open" });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open");
  });

  test("--oldest forwards ASC ordering to every page AND merges oldest-first", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 3, status: "open" }]); // open page
    get.mockResolvedValueOnce([{ feedbackId: 5, status: "reviewed" }]); // reviewed page
    const out = await runFeedbackList(mockClient, { unresolved: true, oldest: true });
    expect(get).toHaveBeenNthCalledWith(
      1,
      "/api/feedback?status=open&limit=200&orderBy=createdAt&orderDirection=ASC"
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/feedback?status=reviewed&limit=200&orderBy=createdAt&orderDirection=ASC"
    );
    // oldest-first: lower feedbackId leads (opposite of the newest-first default)
    expect(out.items.map((r) => r.feedbackId)).toEqual([3, 5]);
  });

  test("forwards --search to every page on the multi-status fan-out", async () => {
    get.mockResolvedValueOnce([]);
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { unresolved: true, search: "weather" });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&search=weather&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&search=weather&limit=200");
  });

  test("truncates description/resolution/errorText to 200 chars by default + sets hint", async () => {
    get.mockResolvedValueOnce([
      {
        feedbackId: 1,
        description: "x".repeat(250),
        resolution: "y".repeat(300),
        errorText: "z".repeat(201),
      },
    ]);
    const out = await runFeedbackList(mockClient, { all: true });
    expect(out.items[0].description).toBe("x".repeat(200) + "...");
    expect(out.items[0].resolution).toBe("y".repeat(200) + "...");
    expect(out.items[0].errorText).toBe("z".repeat(200) + "...");
    expect(out.hint).toMatch(/truncated/);
  });

  test("--full returns untruncated rows and no hint", async () => {
    const longDesc = "x".repeat(250);
    get.mockResolvedValueOnce([{ feedbackId: 1, description: longDesc }]);
    const out = await runFeedbackList(mockClient, { full: true });
    expect(out.items[0].description).toBe(longDesc);
    expect(out.hint).toBeUndefined();
  });

  test("short rows are unchanged and add no hint", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 1, description: "short" }]);
    const out = await runFeedbackList(mockClient, { all: true });
    expect(out.items[0].description).toBe("short");
    expect(out.hint).toBeUndefined();
  });

  test("--unresolved fetches open+reviewed and merges newest-first", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 3, status: "open" }]); // open page
    get.mockResolvedValueOnce([{ feedbackId: 5, status: "reviewed" }]); // reviewed page
    const out = await runFeedbackList(mockClient, { unresolved: true });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&limit=200");
    expect(out.items.map((r) => r.feedbackId)).toEqual([5, 3]);
  });

  test("CSV --status open,applied fetches each and merges desc", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 1 }]); // open
    get.mockResolvedValueOnce([{ feedbackId: 9 }]); // applied
    const out = await runFeedbackList(mockClient, { status: "open,applied" });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=applied&limit=200");
    expect(out.items.map((r) => r.feedbackId)).toEqual([9, 1]);
  });

  test("multi-status forwards --kind to every page", async () => {
    get.mockResolvedValueOnce([]);
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { unresolved: true, kind: "bug" });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&kind=bug&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&kind=bug&limit=200");
  });

  test("--unresolved together with --status exits 4 (no fetch)", async () => {
    await expect(
      runFeedbackList(mockClient, { unresolved: true, status: "open" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(get).not.toHaveBeenCalled();
  });

  test("--all together with --status exits 4 (no fetch)", async () => {
    await expect(
      runFeedbackList(mockClient, { all: true, status: "open" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(get).not.toHaveBeenCalled();
  });

  test("an unknown status in a CSV exits 4 (no fetch)", async () => {
    await expect(
      runFeedbackList(mockClient, { status: "open,bogus" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(get).not.toHaveBeenCalled();
  });
});

// ─── get ───────────────────────────────────────────────────────────────────

describe("ib feedback get", () => {
  test("GETs /api/feedback/:id", async () => {
    get.mockResolvedValueOnce({ feedbackId: 42, status: "open" });
    const out = await runFeedbackGet(mockClient, 42);
    expect(get).toHaveBeenCalledWith("/api/feedback/42");
    expect(out).toMatchObject({ feedbackId: 42 });
  });

  test("accepts --full (cross-command consistency; still returns the full row) — feedback #130", async () => {
    get.mockResolvedValueOnce({ feedbackId: 42, status: "open", description: "x".repeat(500) });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    // Would throw "unknown option '--full'" (exit 4) before the fix.
    await program.parseAsync(["feedback", "get", "42", "--full"], { from: "user" });
    expect(get).toHaveBeenCalledWith("/api/feedback/42");
  });
});

// ─── resolve ─────────────────────────────────────────────────────────────────

describe("ib feedback resolve", () => {
  test("PUTs status + note (as resolution) to /api/feedback/:id", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, status: "applied" });
    const out = await runFeedbackResolve(mockClient, 42, {
      status: "applied",
      note: "shipped in v1.3",
    });
    expect(put).toHaveBeenCalledWith("/api/feedback/42", {
      status: "applied",
      resolution: "shipped in v1.3",
    });
    expect(out).toMatchObject({ status: "applied" });
  });

  test("rejects an unknown status (exit 4), no PUT", async () => {
    await expect(
      runFeedbackResolve(mockClient, 1, { status: "bogus" })
    ).rejects.toThrowError(CliError);
    expect(put).not.toHaveBeenCalled();
  });

  test("--resolution is an alias for --note (matches the output field name; feedback #203)", async () => {
    put.mockResolvedValueOnce({ feedbackId: 7, status: "dismissed" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    await program.parseAsync(
      ["feedback", "resolve", "7", "--status", "dismissed", "--resolution", "by design"],
      { from: "user" }
    );
    expect(put).toHaveBeenCalledWith("/api/feedback/7", {
      status: "dismissed",
      resolution: "by design",
    });
  });

  test("distinct values across --resolution + --reason merge into one note (feedback #216)", async () => {
    put.mockResolvedValueOnce({ feedbackId: 8, status: "applied" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    await program.parseAsync(
      ["feedback", "resolve", "8", "--status", "applied",
        "--resolution", "detailed verification text", "--reason", "verified via ib legal"],
      { from: "user" }
    );
    expect(put).toHaveBeenCalledWith("/api/feedback/8", {
      status: "applied",
      resolution: "detailed verification text\n\nverified via ib legal",
    });
  });

  test("mergeNoteFlags dedupes identical values and returns undefined when none given", () => {
    expect(mergeNoteFlags("same", "same", undefined)).toBe("same");
    expect(mergeNoteFlags(undefined, undefined, undefined)).toBeUndefined();
    expect(mergeNoteFlags("a", undefined, "b")).toBe("a\n\nb");
  });

  test("requires at least one of --status / --note", async () => {
    await expect(runFeedbackResolve(mockClient, 1, {})).rejects.toThrowError(CliError);
    expect(put).not.toHaveBeenCalled();
  });

  test("--dry-run previews the PUT body and never sends", async () => {
    const out = await runFeedbackResolve(mockClient, 42, {
      status: "dismissed",
      note: "by design",
      dryRun: true,
    });
    expect(put).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: {
        method: "PUT",
        path: "/api/feedback/42",
        body: { status: "dismissed", resolution: "by design" },
      },
    });
  });

  test("returns a compact ack by default (drops description, caps resolution)", async () => {
    put.mockResolvedValueOnce({
      feedbackId: 42,
      status: "applied",
      updatedAt: "2026-06-17T00:00:00Z",
      resolution: "z".repeat(250),
      description: "the huge original description the caller already has",
    });
    const out = await runFeedbackResolve(mockClient, 42, { status: "applied" });
    expect(out).toEqual({
      feedbackId: 42,
      status: "applied",
      updatedAt: "2026-06-17T00:00:00Z",
      resolution: "z".repeat(200) + "...",
    });
    expect(out).not.toHaveProperty("description");
  });

  test("--full returns the whole updated row", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, status: "applied", description: "huge original" });
    const out = await runFeedbackResolve(mockClient, 42, { status: "applied", full: true });
    expect(out).toMatchObject({ feedbackId: 42, status: "applied", description: "huge original" });
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe("ib feedback update", () => {
  test("PUTs scope to /api/feedback/:id", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, scope: "security" });
    const out = await runFeedbackUpdate(mockClient, 42, { scope: "security" });
    expect(put).toHaveBeenCalledWith("/api/feedback/42", { scope: "security" });
    expect(out).toMatchObject({ scope: "security" });
  });

  test("PUTs kind + severity + trimmed description together", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, kind: "bug", severity: "major" });
    await runFeedbackUpdate(mockClient, 42, { kind: "bug", severity: "major", description: "  x  " });
    expect(put).toHaveBeenCalledWith("/api/feedback/42", {
      kind: "bug",
      severity: "major",
      description: "x",
    });
  });

  test.each([
    ["scope", { scope: "bogus" }],
    ["kind", { kind: "bogus" }],
    ["severity", { severity: "sev1" }],
    ["complexity", { complexity: 9 }],
  ])("rejects an unknown %s (exit 4), no PUT", async (_label, input) => {
    await expect(runFeedbackUpdate(mockClient, 1, input)).rejects.toThrowError(CliError);
    expect(put).not.toHaveBeenCalled();
  });

  test("promotes complexity on its own (the promote-after-investigation path)", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, complexity: 4 });
    const out = await runFeedbackUpdate(mockClient, 42, { complexity: 4 });
    expect(put).toHaveBeenCalledWith("/api/feedback/42", { complexity: 4 });
    expect(out).toMatchObject({ complexity: 4 });
  });

  test("requires at least one editable field", async () => {
    await expect(runFeedbackUpdate(mockClient, 1, {})).rejects.toThrowError(CliError);
    expect(put).not.toHaveBeenCalled();
  });

  test("rejects a blank description", async () => {
    await expect(
      runFeedbackUpdate(mockClient, 1, { description: "   " })
    ).rejects.toThrowError(CliError);
    expect(put).not.toHaveBeenCalled();
  });

  test("--dry-run previews the PUT body and never sends", async () => {
    const out = await runFeedbackUpdate(mockClient, 42, { scope: "ops", dryRun: true });
    expect(put).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: { method: "PUT", path: "/api/feedback/42", body: { scope: "ops" } },
    });
  });

  test("returns a compact ack by default (caps description, drops resolution)", async () => {
    put.mockResolvedValueOnce({
      feedbackId: 42,
      scope: "security",
      kind: "bug",
      severity: "major",
      updatedAt: "2026-07-11T00:00:00Z",
      description: "d".repeat(250),
      resolution: "should be dropped",
    });
    const out = await runFeedbackUpdate(mockClient, 42, { scope: "security" });
    expect(out).toEqual({
      feedbackId: 42,
      scope: "security",
      kind: "bug",
      severity: "major",
      updatedAt: "2026-07-11T00:00:00Z",
      description: "d".repeat(200) + "...",
    });
    expect(out).not.toHaveProperty("resolution");
  });

  test("--full returns the whole updated row", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, scope: "ops", resolution: "kept" });
    const out = await runFeedbackUpdate(mockClient, 42, { scope: "ops", full: true });
    expect(out).toMatchObject({ feedbackId: 42, scope: "ops", resolution: "kept" });
  });
});

// ─── count ───────────────────────────────────────────────────────────────────

describe("ib feedback count", () => {
  test("aggregates by status, kind, scope", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 1, status: "open", kind: "improvement", scope: "cli" },
      { feedbackId: 2, status: "open", kind: "bug", scope: "app" },
      { feedbackId: 3, status: "applied", kind: "improvement", scope: "cli" },
    ]);
    const out = await runFeedbackCount(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/feedback?limit=200");
    expect(out).toMatchObject({
      total: 3,
      byStatus: { open: 2, reviewed: 0, applied: 1, dismissed: 0 },
      byKind: { improvement: 2, bug: 1 },
      byScope: { cli: 2, app: 1 },
    });
  });

  test("forwards --kind and --scope filters", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackCount(mockClient, { kind: "bug", scope: "cli" });
    expect(get).toHaveBeenCalledWith("/api/feedback?kind=bug&scope=cli&limit=200");
  });

  test("flags truncated when the fetch hits the 200-row cap", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      feedbackId: i,
      status: "open",
      kind: "bug",
      scope: "cli",
    }));
    get.mockResolvedValueOnce(rows);
    const out = await runFeedbackCount(mockClient, {});
    expect(out.truncated).toBe(true);
    expect(out.hint).toMatch(/lower bound/);
  });
});
