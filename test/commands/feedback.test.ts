import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { Command } from "commander";
import {
  runFeedbackCreate,
  runFeedbackList,
  runFeedbackGet,
  runFeedbackResolve,
  mergeNoteFlags,
  runFeedbackUpdate,
  runFeedbackCount,
  runFeedbackLint,
  resolveFeedbackCreateDescription,
  registerFeedbackCommands,
  resolveClaimId,
  type FeedbackResolveInput,
  type FeedbackUpdateInput,
} from "../../src/commands/feedback/index.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, exitCodeFromStatus } from "../../src/api/errors.js";
import { captureActionError, captureStderr, type StderrCapture } from "../helpers/stderr.js";

/**
 * A server error shaped exactly like the client throws one. These fixtures used
 * to pass only (message, status), leaving `exitCode` undefined - harmless for
 * the status-keyed assertions here, but an untyped test/ tree let the arity
 * drift go unnoticed (fb#487).
 */
const httpError = (message: string, status: number) =>
  new CliError(message, status, null, exitCodeFromStatus(status));

const mockClient = mockApiClient();

const post = mockClient.post;
const get = mockClient.get;
const put = mockClient.put;

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

  test("accepts the description via the --body alias (feedback #278)", async () => {
    expect(resolveFeedbackCreateDescription({ bodyFlag: "  via body  " })).toBe("via body");
    // Agreeing sources are fine; disagreeing ones exit 4.
    expect(
      resolveFeedbackCreateDescription({ description: "same", bodyFlag: " same " })
    ).toBe("same");
    expect(
      resolveFeedbackCreateDescription({ descriptionFlag: "same", bodyFlag: "same" })
    ).toBe("same");
    expect(() =>
      resolveFeedbackCreateDescription({ descriptionFlag: "a", bodyFlag: "b" })
    ).toThrowError(/must match/);
    expect(() =>
      resolveFeedbackCreateDescription({ description: "a", bodyFlag: "b" })
    ).toThrowError(/must match/);
    // --title still folds in on top of --body.
    expect(resolveFeedbackCreateDescription({ title: "T", bodyFlag: "b" })).toBe("T\n\nb");

    // End-to-end through the parser: would exit 4 on `unknown option "--body"` before the fix.
    post.mockResolvedValueOnce({ feedbackId: 278 });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    await program.parseAsync(["feedback", "create", "--body", "filed via --body"], { from: "user" });
    expect(post).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({ description: "filed via --body" }),
      expect.objectContaining({ meta: true })
    );
  });

  // ─── fb#299: argv-safe input ───────────────────────────────────────────────
  // A report body is exactly the text most likely to contain double quotes, and
  // PowerShell splits a native arg on those — the CLI then saw N positionals and
  // exited 4. --from-json bypasses argv entirely.
  describe("--from-json (feedback #299)", () => {
    const withJsonFile = async (payload: unknown, fn: (path: string) => Promise<void>) => {
      const p = join(tmpdir(), `ib-feedback-fromjson-${process.pid}.json`);
      writeFileSync(p, JSON.stringify(payload), "utf8");
      try { await fn(p); } finally { unlinkSync(p); }
    };

    test("precedence is explicit flag > JSON > Commander default (shared merge)", async () => {
      // The middle rung is the trap: --kind/--scope declare defaults, so a naive
      // "flags win" would let a default the caller never typed beat the JSON.
      const parse = async (payload: unknown, extra: string[] = []) => {
        await withJsonFile(payload, async (p) => {
          const program = new Command();
          registerFeedbackCommands(program, async () => mockClient);
          await program.parseAsync(["feedback", "create", "--from-json", p, ...extra], { from: "user" });
        });
      };
      post.mockResolvedValue({ feedbackId: 1 });
      await parse({ description: "d", kind: "bug" }); // JSON beats the default
      expect(post.mock.calls[0][1]).toMatchObject({ kind: "bug" });
      await parse({ description: "d", kind: "bug" }, ["--kind", "idea"]); // explicit beats JSON
      expect(post.mock.calls[1][1]).toMatchObject({ kind: "idea" });
      await parse({ description: "d" }); // default survives when neither supplies the key
      expect(post.mock.calls[2][1]).toMatchObject({ kind: "improvement", scope: "cli" });
    });

    test("an unknown JSON key exits 4 naming it and the accepted keys (never silently dropped)", async () => {
      // The fb#298 silent-drop class: the old hand merger IGNORED unknown keys,
      // so `status` here would have been dropped without a trace. Now the shared
      // pipeline rejects it aggregated with the accepted-key list.
      await withJsonFile({ description: "d", status: "applied" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        const { exitCode, envelope } = await captureActionError(() =>
          program.parseAsync(["feedback", "create", "--from-json", p], { from: "user" })
        );
        expect(exitCode).toBe(4);
        expect(String(envelope.error)).toMatch(/unknown key status/);
        expect(String(envelope.error)).toMatch(/accepted: .*description.*severity/);
      });
      expect(post).not.toHaveBeenCalled();
    });

    test("a wrong-typed JSON value is rejected by name (exit 4, no POST)", async () => {
      await withJsonFile({ description: "d", complexity: "high", kind: 5 }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        const { exitCode, envelope } = await captureActionError(() =>
          program.parseAsync(["feedback", "create", "--from-json", p], { from: "user" })
        );
        expect(exitCode).toBe(4);
        expect(String(envelope.error)).toMatch(/"complexity" must be a number/);
        expect(String(envelope.error)).toMatch(/"kind" must be a string/);
      });
      expect(post).not.toHaveBeenCalled();
    });

    test("the read-shape `errorText` key is accepted for --error (fb#357)", async () => {
      // `ib dev feedback get` emits the field as errorText; templating a
      // --from-json file off a read row is the natural way to author one, and
      // the old merger only caught this via an inline `?? s("errorText")` patch.
      // The declared read-shape alias table now carries it.
      post.mockResolvedValueOnce({ feedbackId: 357 });
      await withJsonFile({ description: "d", errorText: "boom" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "create", "--from-json", p], { from: "user" });
      });
      expect(post.mock.calls[0][1]).toMatchObject({ error: "boom" });
    });

    test("a quote-bearing payload round-trips, and JSON kind/scope beat the flag defaults", async () => {
      post.mockResolvedValueOnce({ feedbackId: 299 });
      const description = 'help says "Only keys present are written" but {"aiConfidence":90} is dropped';
      await withJsonFile(
        { description, kind: "bug", scope: "cli", command: "ib glossary set --from-json f.json", error: 'too many arguments for "create"' },
        async (p) => {
          const program = new Command();
          registerFeedbackCommands(program, async () => mockClient);
          await program.parseAsync(["feedback", "create", "--from-json", p], { from: "user" });
        }
      );
      expect(post).toHaveBeenCalledWith(
        "/api/feedback",
        {
          kind: "bug", // NOT the "improvement" default
          scope: "cli",
          description,
          command: "ib glossary set --from-json f.json",
          error: 'too many arguments for "create"',
        },
        { meta: true }
      );
    });

    test("an explicit flag overrides the JSON key", async () => {
      post.mockResolvedValueOnce({ feedbackId: 300 });
      await withJsonFile({ description: "d", kind: "bug" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "create", "--from-json", p, "--kind", "idea"], { from: "user" });
      });
      expect(post.mock.calls[0][1]).toMatchObject({ kind: "idea", description: "d" });
    });

    test("--title in the JSON still folds into the description", async () => {
      post.mockResolvedValueOnce({ feedbackId: 301 });
      await withJsonFile({ title: "T", description: "body" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "create", "--from-json", p], { from: "user" });
      });
      expect(post.mock.calls[0][1]).toMatchObject({ description: "T\n\nbody" });
    });

    test("a missing --from-json file exits 4 without POSTing", async () => {
      const program = new Command();
      registerFeedbackCommands(program, async () => mockClient);
      const prevExit = process.exitCode;
      await program.parseAsync(
        ["feedback", "create", "--from-json", join(tmpdir(), "ib-does-not-exist-299.json")],
        { from: "user" }
      );
      expect(process.exitCode).toBe(4);
      expect(post).not.toHaveBeenCalled();
      process.exitCode = prevExit;
    });
  });

  test("--title folds into the description as its first line (feedback #240/#241)", () => {
    expect(
      resolveFeedbackCreateDescription({ title: " T ", descriptionFlag: "body" })
    ).toBe("T\n\nbody");
    expect(resolveFeedbackCreateDescription({ title: "T", description: "body" })).toBe(
      "T\n\nbody"
    );
    // Title alone is accepted as the whole description.
    expect(resolveFeedbackCreateDescription({ title: "just a title" })).toBe("just a title");
    // No title → unchanged behaviour, including the required-description error.
    expect(resolveFeedbackCreateDescription({ description: "body" })).toBe("body");
    expect(() => resolveFeedbackCreateDescription({})).toThrowError(/description is required/);
  });

  test("gh-issue-style `feedback add --title X --description Y` parses and POSTs the folded description (feedback #240/#241)", async () => {
    post.mockResolvedValueOnce({ feedbackId: 240 });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    // Would throw "unknown option '--title'" (exit 4) before the fix.
    await program.parseAsync(
      ["feedback", "add", "--title", "Row counts missing", "--description", "schema table output should include row counts"],
      { from: "user" }
    );
    expect(post).toHaveBeenCalledWith(
      "/api/feedback",
      {
        kind: "improvement",
        scope: "cli",
        description: "Row counts missing\n\nschema table output should include row counts",
      },
      { meta: true }
    );
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

  // fb#369: --kind used to be the one enum here that silently rewrote an
  // unknown value to "improvement", so a bug filed as `--kind bugs` landed
  // mis-triaged with a success + feedbackId and nothing recording the rewrite.
  test("an unknown --kind exits 4 and never POSTs", async () => {
    await expect(
      runFeedbackCreate(mockClient, { description: "x", kind: "nonsense" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  test("a near-miss --kind names the intended value", async () => {
    await expect(
      runFeedbackCreate(mockClient, { description: "x", kind: "bugs" })
    ).rejects.toMatchObject({ message: expect.stringContaining("did you mean bug?") });
  });

  test("--kind defaults to improvement when omitted", async () => {
    post.mockResolvedValueOnce({ feedbackId: 9 });
    await runFeedbackCreate(mockClient, { description: "x" });
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

  test.each(["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "impeccable", "other"])(
    "--scope %s is accepted and forwarded",
    async (scope) => {
      post.mockResolvedValueOnce({ feedbackId: 1 });
      await runFeedbackCreate(mockClient, { description: "x", scope });
      expect(post.mock.calls[0][1]).toMatchObject({ scope });
    }
  );

  test("unknown --scope exits 4", async () => {
    await expect(
      runFeedbackCreate(mockClient, { description: "x", scope: "nonsense" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  // The issue-tracker vocabulary is the natural first guess and is too far from
  // ours for edit distance to bridge (`high`→`major` is 5 edits) — hence the
  // explicit synonym table. Still exit 4: a hint, never a silent alias (fb#369).
  test.each([
    ["high", "major"],
    ["medium", "minor"],
    ["low", "cosmetic"],
  ])("--severity %s exits 4 and points at %s", async (given, intended) => {
    await expect(
      runFeedbackCreate(mockClient, { description: "x", kind: "bug", severity: given })
    ).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringContaining(`did you mean ${intended}?`),
    });
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
      items: [
        { feedbackId: 1, claimState: "free" },
        { feedbackId: 2, claimState: "free" },
      ],
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

  // Both are server-side SQL filters, so an unknown value would come back as an
  // empty list — indistinguishable from "nothing is filed under that" (fb#369).
  test.each([
    ["kind", { kind: "bugs" }],
    ["scope", { scope: "worksapce" }],
  ])("an unknown --%s exits 4 instead of returning an empty list", async (_f, opts) => {
    await expect(runFeedbackList(mockClient, opts)).rejects.toMatchObject({ exitCode: 4 });
    expect(get).not.toHaveBeenCalled();
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

  test("forwards --complexity none, the unestimated-row selector (fb#535)", async () => {
    // The set both numeric filters exclude by construction, and the one a
    // complexity-backfill pass needs. It has to survive as the literal string:
    // Number("none") is NaN, which the backend's parseInt guard drops as "no
    // filter" — returning the whole table as if nothing had been asked for.
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", complexity: "none" });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&complexity=none");
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

  test("truncates description/resolution/errorText to head+tail by default + sets hint (fb#714)", async () => {
    get.mockResolvedValueOnce([
      {
        feedbackId: 1,
        description: "x".repeat(250),
        resolution: "y".repeat(300),
        errorText: "z".repeat(201),
      },
    ]);
    const out = await runFeedbackList(mockClient, { all: true });
    expect(out.items[0].description).toBe("x".repeat(120) + " … " + "x".repeat(80));
    expect(out.items[0].resolution).toBe("y".repeat(120) + " … " + "y".repeat(80));
    expect(out.items[0].errorText).toBe("z".repeat(120) + " … " + "z".repeat(80));
    expect(out.hint).toMatch(/head\+tail/);
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
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/42",
      { status: "applied", resolution: "shipped in v1.3" },
      expect.anything()
    );
    expect(out).toMatchObject({ status: "applied" });
  });

  test("rejects an unknown status (exit 4), no PUT", async () => {
    await expect(
      runFeedbackResolve(mockClient, 1, { status: "bogus" })
    ).rejects.toThrowError(CliError);
    expect(put).not.toHaveBeenCalled();
  });

  // feedback #327: a resolution note quotes commands/SQL/errors, so it hits the
  // same PowerShell argv-splitting hazard --from-json was added to `create` for.
  describe("--from-json (feedback #327)", () => {
    const withJsonFile = async (payload: unknown, fn: (path: string) => Promise<void>) => {
      const p = join(tmpdir(), `ib-resolve-fromjson-${process.pid}.json`);
      writeFileSync(p, JSON.stringify(payload), "utf8");
      try { await fn(p); } finally { unlinkSync(p); }
    };

    test("precedence: an explicitly-typed flag beats the JSON, JSON beats absent", async () => {
      // resolve declares no Commander defaults, so the ladder is two rungs.
      put.mockResolvedValue({ feedbackId: 4, status: "applied" });
      await withJsonFile({ status: "applied", note: "n" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "resolve", "4", "--from-json", p], { from: "user" });
      });
      expect(put.mock.calls[0][1]).toMatchObject({ status: "applied" }); // JSON beats absent
      await withJsonFile({ status: "applied", note: "n" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(
          ["feedback", "resolve", "4", "--from-json", p, "--status", "dismissed"],
          { from: "user" }
        );
      });
      expect(put.mock.calls[1][1]).toMatchObject({ status: "dismissed" }); // explicit beats JSON
    });

    test("a note in JSON and a different one on argv are both kept (mergeNoteFlags semantics)", async () => {
      put.mockResolvedValueOnce({ feedbackId: 9, status: "applied" });
      await withJsonFile({ status: "applied", note: "from file" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(
          ["feedback", "resolve", "9", "--from-json", p, "--reason", "from argv"],
          { from: "user" }
        );
      });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/9",
        { status: "applied", resolution: "from file\n\nfrom argv" },
        expect.anything()
      );
    });

    test("an unknown JSON key exits 4 naming it and the accepted keys (no PUT)", async () => {
      // The old hand merger silently ignored anything outside its four keys —
      // the fb#298 class the shared pipeline closes.
      await withJsonFile({ status: "applied", resolutionNote: "typo" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        const { exitCode, envelope } = await captureActionError(() =>
          program.parseAsync(["feedback", "resolve", "12", "--from-json", p], { from: "user" })
        );
        expect(exitCode).toBe(4);
        expect(String(envelope.error)).toMatch(/unknown key resolutionNote/);
        expect(String(envelope.error)).toMatch(/accepted: note, reason, resolution, status/);
      });
      expect(put).not.toHaveBeenCalled();
    });

    test("a quote-bearing note round-trips byte-intact through the file", async () => {
      put.mockResolvedValueOnce({ feedbackId: 320, status: "dismissed" });
      const note =
        'Not reproducible. Re-ran \'ib jerry check-address --address "X, Sipoo" --explain\': 665 ms, exit 0.';
      await withJsonFile({ status: "dismissed", note }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "resolve", "320", "--from-json", p], { from: "user" });
      });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/320",
        { status: "dismissed", resolution: note },
        expect.anything()
      );
    });

    test("an explicit --status overrides the file's status", async () => {
      put.mockResolvedValueOnce({ feedbackId: 5, status: "applied" });
      await withJsonFile({ status: "dismissed", note: "n" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(
          ["feedback", "resolve", "5", "--from-json", p, "--status", "applied"],
          { from: "user" }
        );
      });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/5",
        { status: "applied", resolution: "n" },
        expect.anything()
      );
    });

    test("`resolution` is accepted as a JSON key (same alias set as the flags)", async () => {
      put.mockResolvedValueOnce({ feedbackId: 6, status: "applied" });
      await withJsonFile({ status: "applied", resolution: "via the output field name" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "resolve", "6", "--from-json", p], { from: "user" });
      });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/6",
        { status: "applied", resolution: "via the output field name" },
        expect.anything()
      );
    });
  });

  test("--resolution is an alias for --note (matches the output field name; feedback #203)", async () => {
    put.mockResolvedValueOnce({ feedbackId: 7, status: "dismissed" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    await program.parseAsync(
      ["feedback", "resolve", "7", "--status", "dismissed", "--resolution", "by design"],
      { from: "user" }
    );
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/7",
      { status: "dismissed", resolution: "by design" },
      expect.anything()
    );
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
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/8",
      { status: "applied", resolution: "detailed verification text\n\nverified via ib legal" },
      expect.anything()
    );
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
      resolution: "z".repeat(120) + " … " + "z".repeat(80),
    });
    expect(out).not.toHaveProperty("description");
  });

  test("--full returns the whole updated row", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, status: "applied", description: "huge original" });
    const out = await runFeedbackResolve(mockClient, 42, { status: "applied", full: true });
    expect(out).toMatchObject({ feedbackId: 42, status: "applied", description: "huge original" });
  });

  test("note-only resolve that leaves the row open acks with a hint (feedback #270)", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, status: "open", resolution: "investigated" });
    const out = await runFeedbackResolve(mockClient, 42, { note: "investigated" });
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/42",
      { resolution: "investigated" },
      expect.anything()
    );
    expect(out.hint).toBe(
      "status unchanged (open) - pass --status applied|dismissed to close"
    );
  });

  test("note-only hint also fires on a still-reviewed row and under --full", async () => {
    put.mockResolvedValueOnce({ feedbackId: 7, status: "reviewed", description: "orig" });
    const out = await runFeedbackResolve(mockClient, 7, { note: "n", full: true });
    expect(out).toMatchObject({ feedbackId: 7, status: "reviewed", description: "orig" });
    expect(out.hint).toBe(
      "status unchanged (reviewed) - pass --status applied|dismissed to close"
    );
  });

  test("no hint when --status closes the row or is an explicit open/reviewed", async () => {
    put.mockResolvedValueOnce({ feedbackId: 1, status: "applied" });
    const closed = await runFeedbackResolve(mockClient, 1, { status: "applied", note: "done" });
    expect(closed).not.toHaveProperty("hint");

    put.mockResolvedValueOnce({ feedbackId: 2, status: "reviewed" });
    const explicit = await runFeedbackResolve(mockClient, 2, { status: "reviewed", note: "later" });
    expect(explicit).not.toHaveProperty("hint");
  });

  test("no hint when a note-only call lands on an already-closed row", async () => {
    put.mockResolvedValueOnce({ feedbackId: 3, status: "applied", resolution: "post-close note" });
    const out = await runFeedbackResolve(mockClient, 3, { note: "post-close note" });
    expect(out).not.toHaveProperty("hint");
  });
});

// ─── x-claim-id header (resolve/update) ────────────────────────────────────────

/**
 * The claim controller (Task 4) reads `req.headers["x-claim-id"]` to tell a
 * writer's own claim apart from someone else's, so it can suppress the
 * advisory warning when the writer IS the claim holder — without this header
 * every agent resolving its own claimed row gets warned about its own claim.
 * `resolve`/`update` have no `--by` flag, so the header always carries
 * `resolveClaimId(undefined)`: $IB_CLAIM_ID if set, else user@host.
 */
describe("ib feedback resolve/update — x-claim-id header (claim leases)", () => {
  const saved = process.env.IB_CLAIM_ID;
  beforeEach(() => {
    process.env.IB_CLAIM_ID = "test-session";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IB_CLAIM_ID;
    else process.env.IB_CLAIM_ID = saved;
  });

  test("resolve sends the resolved claim label as x-claim-id", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, status: "applied" });
    await runFeedbackResolve(mockClient, 42, { status: "applied" });
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/42",
      expect.anything(),
      { headers: { "x-claim-id": "test-session" } }
    );
  });

  test("update sends the resolved claim label as x-claim-id", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, scope: "security" });
    await runFeedbackUpdate(mockClient, 42, { scope: "security" });
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/42",
      expect.anything(),
      { headers: { "x-claim-id": "test-session" } }
    );
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe("ib feedback update", () => {
  test("PUTs scope to /api/feedback/:id", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, scope: "security" });
    const out = await runFeedbackUpdate(mockClient, 42, { scope: "security" });
    expect(put).toHaveBeenCalledWith("/api/feedback/42", { scope: "security" }, expect.anything());
    expect(out).toMatchObject({ scope: "security" });
  });

  test("PUTs kind + severity + trimmed description together", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, kind: "bug", severity: "major" });
    await runFeedbackUpdate(mockClient, 42, { kind: "bug", severity: "major", description: "  x  " });
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/42",
      { kind: "bug", severity: "major", description: "x" },
      expect.anything()
    );
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
    expect(put).toHaveBeenCalledWith("/api/feedback/42", { complexity: 4 }, expect.anything());
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

  // feedback #332: --description REPLACES the filed report, so a mangled or
  // truncated value destroys the original evidence (no version history to
  // recover it). --from-json removes the shell hazard; --append-description
  // removes the overwrite risk entirely.
  describe("--from-json / --append-description (feedback #332)", () => {
    const withJsonFile = async (payload: unknown, fn: (path: string) => Promise<void>) => {
      const p = join(tmpdir(), `ib-update-fromjson-${process.pid}.json`);
      writeFileSync(p, JSON.stringify(payload), "utf8");
      try { await fn(p); } finally { unlinkSync(p); }
    };

    test("precedence: an explicitly-typed flag beats the JSON", async () => {
      // update declares no Commander defaults, so the ladder is two rungs.
      put.mockResolvedValue({ feedbackId: 42 });
      await withJsonFile({ scope: "cli" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "update", "42", "--from-json", p], { from: "user" });
      });
      expect(put.mock.calls[0][1]).toMatchObject({ scope: "cli" }); // JSON beats absent
      await withJsonFile({ scope: "cli" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(
          ["feedback", "update", "42", "--from-json", p, "--scope", "security"],
          { from: "user" }
        );
      });
      expect(put.mock.calls[1][1]).toMatchObject({ scope: "security" }); // explicit beats JSON
    });

    test("`body` is accepted as a JSON alias for description", async () => {
      put.mockResolvedValueOnce({ feedbackId: 42 });
      await withJsonFile({ body: "via body" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "update", "42", "--from-json", p], { from: "user" });
      });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/42",
        { description: "via body" },
        expect.anything()
      );
    });

    test("an unknown JSON key exits 4 naming it and the accepted keys (no PUT)", async () => {
      // `status` belongs to `resolve`, not `update` — the old hand merger would
      // have silently dropped it and PUT the rest (the fb#298 class).
      await withJsonFile({ scope: "cli", status: "applied" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        const { exitCode, envelope } = await captureActionError(() =>
          program.parseAsync(["feedback", "update", "42", "--from-json", p], { from: "user" })
        );
        expect(exitCode).toBe(4);
        expect(String(envelope.error)).toMatch(/unknown key status/);
        expect(String(envelope.error)).toMatch(/accepted: appendDescription, body, complexity, description, kind, reason, scope, severity/);
      });
      expect(put).not.toHaveBeenCalled();
    });

    test("a quote-bearing description round-trips byte-intact through the file", async () => {
      const description =
        'Root cause: `executeQuery("person","SELECT",...)` returns {recordset} — not an array.';
      put.mockResolvedValueOnce({ feedbackId: 42 });
      await withJsonFile({ description, scope: "cli" }, async (p) => {
        const program = new Command();
        registerFeedbackCommands(program, async () => mockClient);
        await program.parseAsync(["feedback", "update", "42", "--from-json", p], { from: "user" });
      });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/42",
        { scope: "cli", description },
        expect.anything()
      );
    });

    test("--append-description reads the current row and appends, preserving the original", async () => {
      get.mockResolvedValueOnce({ feedbackId: 42, description: "Original report." });
      put.mockResolvedValueOnce({ feedbackId: 42 });
      await runFeedbackUpdate(mockClient, 42, { appendDescription: "  Later finding.  " });
      expect(get).toHaveBeenCalledWith("/api/feedback/42");
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/42",
        { description: "Original report.\n\nLater finding." },
        expect.anything()
      );
    });

    test("appending to an empty description does not leave leading blank lines", async () => {
      get.mockResolvedValueOnce({ feedbackId: 42, description: "" });
      put.mockResolvedValueOnce({ feedbackId: 42 });
      await runFeedbackUpdate(mockClient, 42, { appendDescription: "First text." });
      expect(put).toHaveBeenCalledWith(
        "/api/feedback/42",
        { description: "First text." },
        expect.anything()
      );
    });

    test("--description and --append-description are mutually exclusive (exit 4, no reads/writes)", async () => {
      await expect(
        runFeedbackUpdate(mockClient, 42, { description: "replace", appendDescription: "add" })
      ).rejects.toThrowError(CliError);
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    });

    test("rejects a blank --append-description", async () => {
      await expect(
        runFeedbackUpdate(mockClient, 42, { appendDescription: "   " })
      ).rejects.toThrowError(CliError);
      expect(put).not.toHaveBeenCalled();
    });

    test("--dry-run previews the merged append without writing", async () => {
      get.mockResolvedValueOnce({ feedbackId: 42, description: "Original." });
      const out = await runFeedbackUpdate(mockClient, 42, {
        appendDescription: "Added.",
        dryRun: true,
      });
      expect(out).toMatchObject({
        dryRun: true,
        wouldSend: { method: "PUT", body: { description: "Original.\n\nAdded." } },
      });
      expect(put).not.toHaveBeenCalled();
    });
  });

  test("folds the --body alias into the description patch (feedback #278)", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, description: "edited via body" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    // Would exit 4 with `unknown option "--body"` before the fix.
    await program.parseAsync(["feedback", "update", "42", "--body", "edited via body"], {
      from: "user",
    });
    expect(put).toHaveBeenCalledWith(
      "/api/feedback/42",
      { description: "edited via body" },
      expect.anything()
    );
  });

  test("rejects --description and --body with different values (exit 4, no PUT)", async () => {
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    const prevExit = process.exitCode;
    await program.parseAsync(["feedback", "update", "42", "--description", "a", "--body", "b"], {
      from: "user",
    });
    expect(process.exitCode).toBe(4);
    expect(put).not.toHaveBeenCalled();
    process.exitCode = prevExit;
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
      description: "d".repeat(120) + " … " + "d".repeat(80),
    });
    expect(out).not.toHaveProperty("resolution");
  });

  test("--full returns the whole updated row", async () => {
    put.mockResolvedValueOnce({ feedbackId: 42, scope: "ops", resolution: "kept" });
    const out = await runFeedbackUpdate(mockClient, 42, { scope: "ops", full: true });
    expect(out).toMatchObject({ feedbackId: 42, scope: "ops", resolution: "kept" });
  });
});

// ─── claim-lease advisory warning (resolve/update) ─────────────────────────────

/**
 * PUT /api/feedback/:id attaches a `warning` field when the write just landed
 * on a row another agent currently holds under a LIVE claim — advisory only,
 * never blocking. This is the half of the claim-lease feature that was
 * silently discarded: `compactAck`/`compactUpdateAck` are field WHITELISTS
 * that did not list `warning`, and nothing printed it to stderr either, so an
 * agent overwriting someone else's live claim got no signal at all.
 */
describe("ib feedback resolve/update — claim-lease advisory warning", () => {
  // The warning flows through warnNote → emitStderr (ctx-aware channel) —
  // same spy pattern as the changelog --repo fail-safe warning tests.
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => errSpy.mockRestore());

  const WARNING =
    "Feedback 42 is claimed by other-agent until 2026-08-15T00:00:00.000Z — your change was applied anyway";
  const warnedOnStderr = () =>
    errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(WARNING));

  // Both commands get identical coverage — resolve and update previously
  // diverged (update was missing the --full and printed-exactly-once cases).
  describe.each<["resolve" | "update", Record<string, unknown>]>([
    ["resolve", { status: "applied" }],
    ["update", { scope: "security" }],
  ])("%s", (cmd, extraInput) => {
    const run = (id: number, input: Record<string, unknown>) =>
      cmd === "resolve"
        ? runFeedbackResolve(mockClient, id, input as FeedbackResolveInput)
        : runFeedbackUpdate(mockClient, id, input as FeedbackUpdateInput);

    test("the warning survives into the compact ack", async () => {
      put.mockResolvedValueOnce({ feedbackId: 42, ...extraInput, warning: WARNING });
      const out = await run(42, extraInput);
      expect(out).toMatchObject({ warning: WARNING });
    });

    test("the warning survives under --full too", async () => {
      put.mockResolvedValueOnce({ feedbackId: 42, ...extraInput, warning: WARNING });
      const out = await run(42, { ...extraInput, full: true });
      expect(out).toMatchObject({ warning: WARNING });
    });

    test("a response WITH a warning prints it to stderr", async () => {
      put.mockResolvedValueOnce({ feedbackId: 42, ...extraInput, warning: WARNING });
      await run(42, extraInput);
      expect(warnedOnStderr()).toBe(true);
    });

    test("a response WITHOUT a warning prints nothing", async () => {
      put.mockResolvedValueOnce({ feedbackId: 42, ...extraInput });
      await run(42, extraInput);
      expect(warnedOnStderr()).toBe(false);
    });

    test("the warning is printed exactly once", async () => {
      put.mockResolvedValueOnce({ feedbackId: 42, ...extraInput, warning: WARNING });
      await run(42, extraInput);
      const hits = errSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(WARNING));
      expect(hits).toHaveLength(1);
    });
  });
});

// ─── count ───────────────────────────────────────────────────────────────────

describe("ib feedback count", () => {
  /** The whole-table aggregate the backend now returns. */
  const statsPayload = {
    total: 545,
    byStatus: { open: 91, reviewed: 5, applied: 105, dismissed: 5 },
    byKind: { improvement: 105, bug: 77 },
    byScope: { cli: 71, app: 39 },
    byClaim: { held: 4, free: 541 },
    unestimated: 26,
  };

  test("reads the server-side aggregate, uncapped", async () => {
    get.mockResolvedValueOnce(statsPayload);
    const out = await runFeedbackCount(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/feedback/stats");
    expect(out).toMatchObject(statsPayload);
    // No cap involved, so no lower-bound caveat to carry.
    expect(out.truncated).toBeUndefined();
  });

  test("forwards --kind and --scope filters", async () => {
    get.mockResolvedValueOnce(statsPayload);
    await runFeedbackCount(mockClient, { kind: "bug", scope: "cli" });
    expect(get).toHaveBeenCalledWith("/api/feedback/stats?kind=bug&scope=cli");
  });

  test("falls back to the client-side rollup on a backend without the route", async () => {
    // Deploy-gated: degrade to the previous behaviour rather than break outright.
    get.mockRejectedValueOnce(httpError("Not found", 404));
    get.mockResolvedValueOnce([
      { feedbackId: 1, status: "open", kind: "improvement", scope: "cli", complexity: 2 },
      { feedbackId: 2, status: "open", kind: "bug", scope: "app", complexity: null },
      { feedbackId: 3, status: "applied", kind: "improvement", scope: "cli" },
    ]);
    const out = await runFeedbackCount(mockClient, {});
    expect(get).toHaveBeenLastCalledWith("/api/feedback?limit=200");
    expect(out).toMatchObject({
      total: 3,
      byStatus: { open: 2, reviewed: 0, applied: 1, dismissed: 0 },
      byKind: { improvement: 2, bug: 1 },
      byScope: { cli: 2, app: 1 },
      unestimated: 2,
    });
  });

  test("a permission error propagates instead of silently degrading", async () => {
    // Actionable, and the fallback call would fail identically — answering a
    // permissions problem with quietly capped numbers would be worse than an error.
    get.mockRejectedValueOnce(httpError("Permission denied", 403));
    await expect(runFeedbackCount(mockClient, {})).rejects.toMatchObject({ statusCode: 403 });
  });

  test("falls back on a 500 too — an old backend routes /stats into GET /:id", async () => {
    // Verified against prod: with no /stats route the path matches `/:id` as
    // id="stats", reaches SQL and returns 500 "Conversion failed when converting
    // the nvarchar value 'stats' to data type int" — NOT a 404. Keying the
    // fallback on 404 alone left the command hard-failing on every backend that
    // predates the route.
    get.mockRejectedValueOnce(httpError("Conversion failed", 500));
    get.mockResolvedValueOnce([{ feedbackId: 1, status: "open", kind: "bug", scope: "cli" }]);
    const out = await runFeedbackCount(mockClient, {});
    expect(get).toHaveBeenLastCalledWith("/api/feedback?limit=200");
    expect(out).toMatchObject({ total: 1, byStatus: { open: 1 } });
  });

  test("the fallback still flags truncated at the 200-row cap, naming the bias", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      feedbackId: i,
      status: "open",
      kind: "bug",
      scope: "cli",
    }));
    get.mockRejectedValueOnce(httpError("Not found", 404));
    get.mockResolvedValueOnce(rows);
    const out = await runFeedbackCount(mockClient, {});
    expect(out.truncated).toBe(true);
    expect(out.hint).toMatch(/lower bound/);
    // The bias is the part that changes how the number should be read.
    expect(out.hint).toMatch(/OLDEST/);
  });

  // Unvalidated, an unknown filter reports total:0 — "nothing open" (fb#369).
  test("an unknown --kind exits 4 instead of reporting total 0", async () => {
    await expect(runFeedbackCount(mockClient, { kind: "bugs" })).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("complexity filters announce their NULL blind spot (fb#362)", () => {
  test("--max-complexity adds the exclusion hint", async () => {
    get.mockResolvedValue([{ feedbackId: 1, complexity: 2, status: "open" }]);
    const env = await runFeedbackList(mockClient as never, { maxComplexity: 2, all: true });
    expect(env.hint).toMatch(/EXCLUDES rows with no estimate/);
  });

  test("--complexity adds it too", async () => {
    get.mockResolvedValue([{ feedbackId: 1, complexity: 1, status: "open" }]);
    const env = await runFeedbackList(mockClient as never, { complexity: 1, all: true });
    expect(env.hint).toMatch(/EXCLUDES rows with no estimate/);
  });

  test("an unfiltered list carries no complexity hint", async () => {
    get.mockResolvedValue([{ feedbackId: 1, complexity: null, status: "open" }]);
    const env = await runFeedbackList(mockClient as never, { all: true });
    expect(env.hint).toBeUndefined();
  });

  test("the truncation hint and the complexity hint coexist", async () => {
    get.mockResolvedValue([
      { feedbackId: 1, complexity: 2, status: "open", description: "x".repeat(300) },
    ]);
    const env = await runFeedbackList(mockClient as never, { maxComplexity: 2, all: true });
    expect(env.hint).toMatch(/head\+tail/);
    expect(env.hint).toMatch(/EXCLUDES rows with no estimate/);
  });
});

/**
 * fb#583: `feedback create <description>` takes its prose POSITIONALLY and
 * `feedback resolve <id>` did not — two sibling commands in one group, each
 * taking one id-ish thing plus one block of prose, disagreeing about where the
 * prose goes. The reporter typed `resolve 553 --status applied -- "…"` twice in
 * a row and got an exit 4 that never mentioned --note.
 */
describe("feedback resolve — the note is positional too (fb#583)", () => {
  test("a positional note is stored as the resolution, like --note", async () => {
    const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() };
    mockClient.put.mockResolvedValue({ feedbackId: 553, status: "applied", resolution: "Folded into fb#576" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient as never);
    await program.parseAsync(
      ["feedback", "resolve", "553", "--status", "applied", "--", "Folded into fb#576"],
      { from: "user" }
    );
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/feedback/553",
      expect.objectContaining({ status: "applied", resolution: "Folded into fb#576" }),
      expect.anything()
    );
  });

  test("positional and --note merge when they differ, rather than one being dropped", async () => {
    const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() };
    mockClient.put.mockResolvedValue({ feedbackId: 42, status: "applied" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient as never);
    await program.parseAsync(
      ["feedback", "resolve", "42", "positional half", "--note", "flag half"],
      { from: "user" }
    );
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/feedback/42",
      expect.objectContaining({ resolution: "positional half\n\nflag half" }),
      expect.anything()
    );
  });

  test("the same text given both ways is stored ONCE — mergeNoteFlags de-dupes", async () => {
    const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() };
    mockClient.put.mockResolvedValue({ feedbackId: 42, status: "applied" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient as never);
    await program.parseAsync(
      ["feedback", "resolve", "42", "same text", "--note", "same text"],
      { from: "user" }
    );
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/feedback/42",
      expect.objectContaining({ resolution: "same text" }),
      expect.anything()
    );
  });

  test("no note at all still works — a status-only resolve is unchanged", async () => {
    const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() };
    mockClient.put.mockResolvedValue({ feedbackId: 42, status: "dismissed" });
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient as never);
    await program.parseAsync(["feedback", "resolve", "42", "--status", "dismissed"], { from: "user" });
    const body = mockClient.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.status).toBe("dismissed");
    expect(body.resolution).toBeUndefined();
  });

  /**
   * The excess-args row survives and gets MORE accurate: one positional is now
   * the note, so reaching exit 4 takes two or more — which on PowerShell means
   * the shell split the note, exactly what that row's remedy addresses.
   */
  test("TWO excess positionals still exit 4 — that is the shell-split case", async () => {
    const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() };
    const program = new Command();
    program.exitOverride();
    registerFeedbackCommands(program, async () => mockClient as never);
    await expect(
      program.parseAsync(["feedback", "resolve", "42", "note one", "note two"], { from: "user" })
    ).rejects.toThrow();
    expect(mockClient.put).not.toHaveBeenCalled();
  });
});

/**
 * fb#605: the single-status path never set `truncated`. `--limit 1000 --all`
 * returned 200 rows of 604 and looked like the whole table — a sweep over every
 * row would have reported itself complete having seen the newest fifth. The
 * multi-status merge path below it had guarded this all along.
 */
describe("ib feedback list — the 200-row cap is reported (fb#605)", () => {
  test("THE BUG: --all --limit 1000 returns a capped page and now says so", async () => {
    get.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ feedbackId: i })));
    const out = await runFeedbackList(mockClient, { all: true, limit: 1000 });
    // 200 never equals the requested 1000, which is why comparing against the
    // RAW request missed it; the effective limit is min(requested, cap).
    expect(out.truncated).toBe(true);
    expect(out.count).toBe(200);
  });

  test("a default-sized full page is truncated too", async () => {
    get.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ feedbackId: i })));
    const out = await runFeedbackList(mockClient, { all: true });
    expect(out.truncated).toBe(true);
  });

  test("a short page stays quiet — no false alarm on the ordinary read", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 1 }, { feedbackId: 2 }]);
    const out = await runFeedbackList(mockClient, { all: true, limit: 50 });
    expect(out.truncated).toBeUndefined();
  });
});

/**
 * fb#647: a PARTLY-fixed row was indistinguishable from an untouched one at the
 * moment an agent picks its next item.
 *
 * `ib dev changelog add --feedback <id> --no-resolve` has always been able to
 * record a shipped half WITHOUT closing the row — but the list read never
 * carried the resulting link, so browsing `--unclaimed` showed nothing, the row
 * got claimed, and a full investigation cycle went into rediscovering work that
 * had already shipped. One stderr line at list time replaces that.
 */
describe("ib feedback list — partly-shipped rows are named (fb#647)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => errSpy.mockRestore());

  const note = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  test("THE BUG: a linked-but-open row is called out before it can be claimed", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 418, status: "open", changelogLinks: [{ changelogId: 1189, role: "references" }] },
      { feedbackId: 500, status: "open", changelogLinks: [] },
    ]);
    await runFeedbackList(mockClient, { all: true });
    expect(note()).toMatch(/1 of 2 un-closed rows already carry changelog links/);
    expect(note()).toMatch(/fb#418 → cl#1189/);
  });

  test("the links survive into the items — the JSON contract, not just the note", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 418, description: "x", changelogLinks: [{ changelogId: 1189, role: "references" }] },
    ]);
    const out = await runFeedbackList(mockClient, { all: true });
    expect(out.items[0].changelogLinks).toEqual([{ changelogId: 1189, role: "references" }]);
  });

  test("a page with no linked rows stays silent", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 500, changelogLinks: [] }, { feedbackId: 501 }]);
    await runFeedbackList(mockClient, { all: true });
    expect(note()).not.toMatch(/changelog links/);
  });

  test("an older backend (no field at all) stays silent — absence is not 'nothing shipped'", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 500 }, { feedbackId: 501 }]);
    await runFeedbackList(mockClient, { all: true });
    expect(note()).not.toMatch(/changelog links/);
  });

  test("a CLOSED page stays silent — every closed row has a resolves link by construction", async () => {
    // Counting those made the note fire on all three rows of `--status applied`
    // while asserting they had shipped "without closing the row".
    get.mockResolvedValueOnce([
      { feedbackId: 647, status: "applied", changelogLinks: [{ changelogId: 1396, role: "resolves" }] },
      { feedbackId: 646, status: "dismissed", changelogLinks: [{ changelogId: 1393, role: "resolves" }] },
    ]);
    await runFeedbackList(mockClient, { status: "applied,dismissed" });
    expect(note()).not.toMatch(/changelog links/);
  });

  test("the count is of UN-CLOSED rows, not the whole page", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 418, status: "open", changelogLinks: [{ changelogId: 1189, role: "references" }] },
      { feedbackId: 647, status: "applied", changelogLinks: [{ changelogId: 1396, role: "resolves" }] },
      { feedbackId: 500, status: "reviewed", changelogLinks: [] },
    ]);
    await runFeedbackList(mockClient, { all: true });
    expect(note()).toMatch(/1 of 2 un-closed rows/);
    expect(note()).not.toMatch(/fb#647/);
  });

  test("names at most five rows, then counts the rest", async () => {
    get.mockResolvedValueOnce(
      Array.from({ length: 7 }, (_, i) => ({
        feedbackId: 400 + i,
        status: "open",
        changelogLinks: [{ changelogId: 1000 + i, role: "references" }],
      }))
    );
    await runFeedbackList(mockClient, { all: true });
    expect(note()).toMatch(/\+2 more/);
    expect(note()).not.toMatch(/fb#405/);
  });

  test("a row with several links renders them all", async () => {
    get.mockResolvedValueOnce([
      {
        feedbackId: 168,
        status: "open",
        changelogLinks: [
          { changelogId: 900, role: "references" },
          { changelogId: 901, role: "references" },
        ],
      },
    ]);
    await runFeedbackList(mockClient, { all: true });
    expect(note()).toMatch(/fb#168 → cl#900\+cl#901/);
  });
});

/**
 * The severity filter + its deploy-gate detector.
 *
 * Severity was in ALLOWED_ORDER_BY but had no filter, so "which rows still need
 * a grade?" was unanswerable from one call — the grooming skill pulled the whole
 * active list and filtered client-side, against a page capped at 200 whose drops
 * are the OLDEST. Same silent under-report fb#536 fixed for counts, fb#605 for
 * the list.
 */
describe("ib feedback list — --severity filter", () => {
  test("forwards a named severity on the single-status path", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", severity: "critical" });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&severity=critical");
  });

  test("forwards --severity none, the UNGRADED-row selector", async () => {
    // The severity twin of `--complexity none`: the set a backfill pass needs,
    // and the one a named severity excludes by construction.
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", severity: "none" });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&severity=none");
  });

  test("rides along on the multi-status fan-out too", async () => {
    get.mockResolvedValueOnce([]);
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { severity: "none" });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&severity=none&limit=200");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&severity=none&limit=200");
  });

  test("an unknown severity exits 4 rather than returning the whole table", async () => {
    // toMatchObject, not toThrow: the title claims an exit CODE, and the file's
    // own convention pins it that way everywhere else.
    await expect(
      runFeedbackList(mockClient, { status: "open", severity: "urgent" })
    ).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringMatching(/--severity must be one of/),
    });
  });

  test("the rejection message LISTS `none` — the spec and the runtime agree", async () => {
    // These disagreed: the check ran against SEVERITIES with a bypass branch for
    // `none`, so a typo was told the valid set was "critical, major, minor,
    // cosmetic" while the spec's machine-readable `allowed` included `none`.
    await expect(
      runFeedbackList(mockClient, { status: "open", severity: "urgent" })
    ).rejects.toMatchObject({ message: expect.stringMatching(/\bnone\b/) });
  });

  test.each([
    ["high", "major"],
    ["medium", "minor"],
    ["low", "cosmetic"],
    ["blocker", "critical"],
  ])("the issue-tracker word %s is redirected to %s", async (typed, suggested) => {
    // The vocabulary most tooling reaches for first, and too far from ours for
    // edit distance to bridge (high→major is 5 edits). Previously only `high`
    // was exercised, leaving 4 of the 5 synonym entries unproven.
    await expect(
      runFeedbackList(mockClient, { status: "open", severity: typed })
    ).rejects.toThrow(new RegExp(`did you mean ${suggested}`));
  });

  test("`trivial` is suggested `cosmetic`, not the edit-distance-closer `critical`", async () => {
    // SEVERITY_SYNONYMS maps trivial→cosmetic. assertEnum (src/targets.ts) used
    // to consult `closestName` BEFORE `synonyms`, and `trivial` is within edit
    // distance of `critical` (both 8 chars), so the fuzzy match won and the
    // synonym never ran — suggesting the opposite end of the severity ladder,
    // the worst direction to be wrong in on this flag, since acting on it files
    // the least urgent thing as the most. Fixed by checking synonyms first.
    await expect(
      runFeedbackList(mockClient, { status: "open", severity: "trivial" })
    ).rejects.toThrow(/did you mean cosmetic/);
  });
});

describe("ib feedback list — a backend that IGNORES --severity is caught", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => errSpy.mockRestore());

  const note = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  test("THE BUG: --severity none answered with graded rows is not read as 'all ungraded'", async () => {
    // An older backend does not reject an unknown query param, it ignores it and
    // answers unfiltered. For `none` that returns every active row and reads as
    // "the whole queue needs grading" — which would send a groomer to re-grade
    // rows that are already graded, the exact thing fill-NULLs-only prevents.
    get.mockResolvedValueOnce([
      { feedbackId: 1, severity: "major", status: "open" },
      { feedbackId: 2, severity: null, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", severity: "none" });
    expect(note()).toMatch(/--severity was IGNORED by this backend/);
    expect(out.hint).toMatch(/UNFILTERED by severity/);
  });

  test("a named severity answered with a different one is caught the same way", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 1, severity: "critical", status: "open" },
      { feedbackId: 2, severity: "cosmetic", status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", severity: "critical" });
    expect(note()).toMatch(/IGNORED/);
    expect(out.hint).toMatch(/UNFILTERED by severity/);
  });

  test("an obedient backend stays silent", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 1, severity: null, status: "open" },
      { feedbackId: 2, severity: null, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", severity: "none" });
    expect(note()).not.toMatch(/IGNORED/);
    expect(out.hint ?? "").not.toMatch(/UNFILTERED/);
  });

  test("an obedient backend stays silent for a NAMED severity too", async () => {
    // The named branch of severityFilterIgnored was pinned by nothing: inverting
    // `r.severity === severity` to `!==` left all five original tests green. The
    // violated-case test warns either way, and the other three short-circuit on
    // the `!severity` / `!rows.length` guards before the comparison runs. This is
    // the only case where the named branch must return FALSE, so it is the only
    // one that dies when the comparison flips.
    get.mockResolvedValueOnce([
      { feedbackId: 1, severity: "critical", status: "open" },
      { feedbackId: 2, severity: "critical", status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", severity: "critical" });
    expect(note()).not.toMatch(/IGNORED/);
    expect(out.hint ?? "").not.toMatch(/UNFILTERED/);
  });

  test("an EMPTY result is never flagged — it proves nothing either way", async () => {
    // A genuinely empty slice and a filtered-out one look identical, so warning
    // here would cry wolf on the single most common clean-queue answer.
    get.mockResolvedValueOnce([]);
    const out = await runFeedbackList(mockClient, { status: "open", severity: "critical" });
    expect(note()).not.toMatch(/IGNORED/);
    expect(out.hint ?? "").not.toMatch(/UNFILTERED/);
  });

  test("no --severity means no check at all", async () => {
    get.mockResolvedValueOnce([{ feedbackId: 1, severity: "major", status: "open" }]);
    const out = await runFeedbackList(mockClient, { status: "open" });
    expect(out.hint ?? "").not.toMatch(/UNFILTERED/);
  });
});

/**
 * The --held filter (fb#886) + its deploy-gate detector — the --severity
 * pattern applied to claim state, because the silent-ignore points the same
 * wrong way: an older backend answering unfiltered reads as "everything is
 * claimed".
 */
describe("ib feedback list — --held filter", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => errSpy.mockRestore());

  const note = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  test("emits the literal query string held=1 (the backend's exact truthy set)", async () => {
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { status: "open", held: true });
    expect(get).toHaveBeenCalledWith("/api/feedback?status=open&held=1");
  });

  test("rides along on the multi-status fan-out too", async () => {
    get.mockResolvedValueOnce([]);
    get.mockResolvedValueOnce([]);
    await runFeedbackList(mockClient, { held: true });
    expect(get).toHaveBeenNthCalledWith(1, "/api/feedback?status=open&limit=200&held=1");
    expect(get).toHaveBeenNthCalledWith(2, "/api/feedback?status=reviewed&limit=200&held=1");
  });

  test("THE GAP: an older backend ignoring --held is not read as 'everything is claimed'", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 1, claimedBy: "someone", claimExpiresAt: FUTURE, status: "open" },
      { feedbackId: 2, claimedBy: null, claimExpiresAt: null, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", held: true });
    expect(note()).toMatch(/--held was IGNORED by this backend/);
    expect(out.hint).toMatch(/UNFILTERED by claim state/);
  });

  test("an EXPIRED lease counts as a violation — held means live, per claimState", async () => {
    const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    get.mockResolvedValueOnce([
      { feedbackId: 1, claimedBy: "someone", claimExpiresAt: PAST, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", held: true });
    expect(out.hint).toMatch(/UNFILTERED by claim state/);
  });

  test("an obedient backend stays silent", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 1, claimedBy: "a", claimExpiresAt: FUTURE, status: "open" },
      { feedbackId: 2, claimedBy: "b", claimExpiresAt: FUTURE, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open", held: true });
    expect(note()).not.toMatch(/IGNORED/);
    expect(out.hint ?? "").not.toMatch(/UNFILTERED/);
  });

  test("an EMPTY result is never flagged — it proves nothing either way", async () => {
    get.mockResolvedValueOnce([]);
    const out = await runFeedbackList(mockClient, { status: "open", held: true });
    expect(note()).not.toMatch(/IGNORED/);
    expect(out.hint ?? "").not.toMatch(/UNFILTERED/);
  });
});

/**
 * claimState "mine" under a DERIVED (user@host fallback) identity (fb#901):
 * every unset-$IB_CLAIM_ID session on a host shares that one label, so "mine"
 * actively misreports another session's claim as this caller's own.
 */
describe("ib feedback list — claimState under a derived identity (fb#901)", () => {
  let cap: StderrCapture;
  const savedId = process.env.IB_CLAIM_ID;
  beforeEach(() => {
    delete process.env.IB_CLAIM_ID;
    cap = captureStderr();
  });
  afterEach(() => {
    cap.restore();
    if (savedId === undefined) delete process.env.IB_CLAIM_ID;
    else process.env.IB_CLAIM_ID = savedId;
  });
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  test("a row claimed under the fallback label reports 'held', not 'mine', and warns", async () => {
    const derivedMe = resolveClaimId(undefined);
    get.mockResolvedValueOnce([
      { feedbackId: 1, claimedBy: derivedMe, claimExpiresAt: FUTURE, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open" });
    expect(out.items[0]).toMatchObject({ feedbackId: 1, claimState: "held" });
    expect(cap.text()).toMatch(/DERIVED from user@host/);
  });

  test("an explicit IB_CLAIM_ID still reports 'mine' with no warning", async () => {
    process.env.IB_CLAIM_ID = "hermes/groom";
    get.mockResolvedValueOnce([
      { feedbackId: 1, claimedBy: "hermes/groom", claimExpiresAt: FUTURE, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open" });
    expect(out.items[0]).toMatchObject({ feedbackId: 1, claimState: "mine" });
    expect(cap.text()).not.toMatch(/downgraded/);
  });

  test("a row held by SOMEONE ELSE under a derived identity is unaffected ('held' either way)", async () => {
    get.mockResolvedValueOnce([
      { feedbackId: 1, claimedBy: "someone-else", claimExpiresAt: FUTURE, status: "open" },
    ]);
    const out = await runFeedbackList(mockClient, { status: "open" });
    expect(out.items[0]).toMatchObject({ feedbackId: 1, claimState: "held" });
    expect(cap.text()).not.toMatch(/downgraded/);
  });
});

describe("ib feedback lint", () => {
  test("GETs the server-side audit and wraps it in the list envelope", async () => {
    // Thin by design: the value is that the audit runs server-side over the
    // WHOLE table. Doing it client-side means a 200-row page whose drops are
    // the oldest — exactly the rows a completeness audit exists to surface.
    const findings = [
      { feedbackId: 12, issue: "ungraded", detail: "severity missing", severity: "warn" },
      { feedbackId: 40, issue: "applied-no-changelog", detail: "…", severity: "info" },
    ];
    get.mockResolvedValueOnce(findings);
    const out = await runFeedbackLint(mockClient);
    expect(get).toHaveBeenCalledWith("/api/feedback/lint");
    expect(out.items).toEqual(findings);
    expect(out.count).toBe(2);
  });

  test("a clean queue is an empty list, not an error", async () => {
    get.mockResolvedValueOnce([]);
    const out = await runFeedbackLint(mockClient);
    expect(out.items).toEqual([]);
    expect(out.count).toBe(0);
  });

  test("a non-array body degrades to empty rather than throwing", async () => {
    get.mockResolvedValueOnce(null as never);
    expect((await runFeedbackLint(mockClient)).items).toEqual([]);
  });
});

describe("ib feedback lint --strict — the gate the warn/info split exists to serve", () => {
  /**
   * feedbackStats.test.js pins WHICH issues are warn vs info, but the only
   * consumer of that distinction is this flag. Without these two tests the
   * `.some(f => f.severity === "warn")` predicate could be deleted outright and
   * nothing would go red — i.e. the design decision was documented and pinned
   * everywhere except where it actually takes effect.
   */
  const runLint = async (findings: unknown[], argv: string[]) => {
    get.mockResolvedValueOnce(findings);
    const program = new Command();
    registerFeedbackCommands(program, async () => mockClient);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    await program.parseAsync(["feedback", "lint", ...argv], { from: "user" });
    const observed = process.exitCode;
    process.exitCode = prevExit;
    return observed;
  };

  test("--strict exits 1 when a warn-level finding exists", async () => {
    expect(
      await runLint(
        [{ feedbackId: 1, issue: "ungraded", detail: "severity missing", severity: "warn" }],
        ["--strict"]
      )
    ).toBe(1);
  });

  test("--strict does NOT exit 1 on info-only findings — that IS the design", async () => {
    // The historical documentation-gap backlog is large and no single run clears
    // it. Gating on it would make --strict permanently red, and a check that is
    // always red gets rubber-stamped instead of read.
    expect(
      await runLint(
        [
          { feedbackId: 2, issue: "applied-no-changelog", detail: "…", severity: "info" },
          { feedbackId: 3, issue: "closed-no-resolution", detail: "…", severity: "info" },
        ],
        ["--strict"]
      )
    ).not.toBe(1);
  });

  test("a clean queue under --strict exits 0", async () => {
    expect(await runLint([], ["--strict"])).not.toBe(1);
  });

  test("WITHOUT --strict a warn finding still exits 0 — it reports, it does not gate", async () => {
    expect(
      await runLint(
        [{ feedbackId: 1, issue: "ungraded", detail: "severity missing", severity: "warn" }],
        []
      )
    ).not.toBe(1);
  });
});
