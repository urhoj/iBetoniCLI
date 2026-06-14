import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runFeedbackCreate,
  runFeedbackList,
  runFeedbackGet,
  runFeedbackResolve,
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

  test.each(["cli", "app", "jerry", "bsg2", "workspace", "other"])(
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

  test("no filters → bare path, empty array tolerated", async () => {
    get.mockResolvedValueOnce(null);
    const out = await runFeedbackList(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/feedback");
    expect(out).toEqual({ items: [], nextCursor: null, count: 0 });
  });

  test("forwards --scope filter", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { scope: "workspace" });
    expect(get).toHaveBeenCalledWith("/api/feedback?scope=workspace");
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
});
