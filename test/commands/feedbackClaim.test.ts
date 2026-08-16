import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveClaimId,
  runFeedbackClaim,
  runFeedbackRelease,
  runFeedbackList,
  deriveClaimState,
} from "../../src/commands/feedback/index.js";
import { CliError, exitCodeFromStatus, hintForError } from "../../src/api/errors.js";
import { makeEmbeddedCtx, runEmbedded } from "../../src/embedded.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

function mockClient() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ feedbackId: 42, claimedBy: "c6b96c" }),
    put: vi.fn(),
    delete: vi.fn().mockResolvedValue({ feedbackId: 42, released: true }),
    getCurrentToken: vi.fn(),
  } as never;
}

describe("resolveClaimId", () => {
  const saved = process.env.IB_CLAIM_ID;
  beforeEach(() => { delete process.env.IB_CLAIM_ID; });
  afterEach(() => { if (saved === undefined) delete process.env.IB_CLAIM_ID; else process.env.IB_CLAIM_ID = saved; });

  test("an explicit --by wins", () => {
    process.env.IB_CLAIM_ID = "from-env";
    expect(resolveClaimId("c6b96c")).toBe("c6b96c");
  });

  test("falls back to IB_CLAIM_ID for cron/Hermes runs", () => {
    process.env.IB_CLAIM_ID = "hermes/groom";
    expect(resolveClaimId(undefined)).toBe("hermes/groom");
  });

  test("falls back to user@host — coarse but never empty", () => {
    const id = resolveClaimId(undefined);
    expect(id).toMatch(/@/);
    expect(id.length).toBeGreaterThan(1);
  });

  test("caps the label at the column width (120)", () => {
    expect(resolveClaimId("x".repeat(300))).toHaveLength(120);
  });
});

describe("runFeedbackClaim", () => {
  test("POSTs to the claim path with the resolved label", async () => {
    const client = mockClient();
    await runFeedbackClaim(client, 42, { by: "c6b96c" });
    expect((client as never as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
      "/api/feedback/42/claim",
      expect.objectContaining({ by: "c6b96c" }),
      expect.anything()
    );
  });

  test("omits ttlHours and steal when not asked for", async () => {
    const client = mockClient();
    await runFeedbackClaim(client, 42, { by: "c6b96c" });
    const body = (client as never as { post: ReturnType<typeof vi.fn> }).post.mock.calls[0][1];
    expect(body).not.toHaveProperty("ttlHours");
    expect(body).not.toHaveProperty("steal");
  });

  test("passes ttlHours and steal through when given", async () => {
    const client = mockClient();
    await runFeedbackClaim(client, 42, { by: "c6b96c", ttlHours: 6, steal: true });
    const body = (client as never as { post: ReturnType<typeof vi.fn> }).post.mock.calls[0][1];
    expect(body).toMatchObject({ ttlHours: 6, steal: true });
  });
});

describe("runFeedbackRelease", () => {
  test("DELETEs one row's claim, carrying the label in the QUERY STRING", async () => {
    // ApiClient.delete takes (path, opts?: FetchOptions) and FetchOptions has no
    // `body` — a label passed as a second argument would silently never be sent.
    const client = mockClient();
    await runFeedbackRelease(client, 42, { by: "c6b96c" });
    expect((client as never as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith(
      "/api/feedback/42/claim?by=c6b96c",
      expect.anything()
    );
  });

  test("--all POSTs the bulk path instead", async () => {
    const client = mockClient();
    await runFeedbackRelease(client, null, { by: "c6b96c", all: true });
    expect((client as never as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
      "/api/feedback/claims/release",
      { by: "c6b96c" },
      expect.anything()
    );
  });
});

/**
 * Fix round 1: the --ttl-hours range check is SERVER-side (feedback.js
 * `claim()` -> `sendValidationError` -> HTTP 400), not client-side —
 * `runFeedbackClaim` forwards `ttlHours` unchecked. The spec's error row for
 * it must therefore be HTTP-origin (`http: 400`), never `origin: "client"` —
 * a client row is only ever consulted when `err.statusCode === 0`
 * (`hintForError` -> `matchClientRow`), and a real backend 400 always carries
 * `statusCode: 400`. An `origin: "client"` row here would be silently DEAD:
 * the remedy would never surface, and the agent would get no hint at all for
 * a common, documented misuse.
 */
describe("ib dev feedback claim — ttl-hours 400 remedy is reachable (fix round 1)", () => {
  const spec = COMMAND_SPECS.find((s) => s.command === "ib dev feedback claim");

  test("the spec has an http-origin row for the ttlHours validation error", () => {
    expect(spec).toBeDefined();
    const row = spec!.errors?.find((r) => "match" in r && r.match === "ttlhours");
    expect(row).toBeDefined();
    expect(row).toHaveProperty("http", 400);
    expect(row).not.toHaveProperty("origin");
  });

  test("a real 400 (as the backend actually raises it) resolves to the documented remedy, not null", () => {
    // Mirrors the real failure exactly: feedback.js claim() -> sendValidationError
    // (HTTP 400, message "ttlHours must be a number 1-24") -> errorMessageFromBody
    // extracts body.error/message -> the CLI's CliError carries the REAL
    // statusCode (400) — never 0, so a client-origin row could never match it.
    const err = new CliError(
      "ttlHours must be a number 1-24",
      400,
      null,
      exitCodeFromStatus(400)
    );
    expect(hintForError(err, spec!.errors)).toBe("--ttl-hours must be 1-24");
  });

  test("regression guard: an origin:'client' row is UNREACHABLE for this same error", () => {
    // Proves the failure mode the fix corrects: matchClientRow only runs when
    // err.statusCode === 0, so a client-origin row — however well the `match`
    // string is written — can never answer a real HTTP 400. This is what the
    // brief's original row looked like before the fix.
    const deadRow = {
      origin: "client" as const,
      exit: 4,
      match: "ttlhours",
      meaning: "Validation",
      remedy: "--ttl-hours must be 1-24 (dead — unreachable for a real 400)",
    };
    const err = new CliError("ttlHours must be a number 1-24", 400, null, exitCodeFromStatus(400));
    expect(hintForError(err, [deadRow])).toBeNull();
  });
});

describe("deriveClaimState", () => {
  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
  const PAST = new Date(Date.now() - 3_600_000).toISOString();

  test("no claim is free", () => {
    expect(deriveClaimState({ claimedBy: null, claimExpiresAt: null }, "me")).toBe("free");
  });

  test("an EXPIRED claim is free, not held — this is the 24h reclamation", () => {
    expect(deriveClaimState({ claimedBy: "them", claimExpiresAt: PAST }, "me")).toBe("free");
  });

  test("a live claim by someone else is held", () => {
    expect(deriveClaimState({ claimedBy: "them", claimExpiresAt: FUTURE }, "me")).toBe("held");
  });

  test("a live claim by me is mine", () => {
    expect(deriveClaimState({ claimedBy: "me", claimExpiresAt: FUTURE }, "me")).toBe("mine");
  });

  // Fix round 1: `new Date("garbage").getTime()` is NaN, and `NaN <= Date.now()`
  // is false — an unguarded comparison would fall through to "held", which is
  // backwards for a mechanism whose whole point is that a lease self-heals.
  // Malformed data must degrade toward FREE, not lock in as permanently held.
  test("an UNPARSEABLE claimExpiresAt degrades to free, not held (fix round 1)", () => {
    expect(deriveClaimState({ claimedBy: "them", claimExpiresAt: "not-a-date" }, "me")).toBe(
      "free"
    );
  });
});

describe("runFeedbackList — claim filters are mutually exclusive", () => {
  // Fix round 1: assert BOTH the exit code (not just "some rejection") AND that
  // the guard fires before any network call — proving it's a pre-flight check,
  // not a wasted round trip that happens to also throw afterward.
  test("--unclaimed with --mine exits 4, before any fetch", async () => {
    const client = mockClient();
    await expect(
      runFeedbackList(client, { unclaimed: true, mine: true } as never)
    ).rejects.toMatchObject({ exitCode: 4 });
    expect((client as never as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
  });
});

/**
 * The backend's truthy check is EXACTLY `req.query.unclaimed === "1" ||
 * req.query.unclaimed === "true"` — a bare `?unclaimed` (Express yields `""`)
 * or any other spelling reads as false and the filter goes silently inert.
 * Pin the emitted query string, not just that SOME value was sent.
 */
describe("runFeedbackList — claim filters reach the wire correctly", () => {
  test("--unclaimed emits the literal query string unclaimed=1", async () => {
    const client = mockClient();
    await runFeedbackList(client, { unclaimed: true });
    const url = (client as never as { get: ReturnType<typeof vi.fn> }).get.mock.calls[0][0] as string;
    expect(url).toContain("unclaimed=1");
  });

  test("--mine resolves to claimedBy=<resolved label> on the wire", async () => {
    const client = mockClient();
    await runFeedbackList(client, { mine: true });
    const url = (client as never as { get: ReturnType<typeof vi.fn> }).get.mock.calls[0][0] as string;
    const expected = new URLSearchParams({ claimedBy: resolveClaimId(undefined) }).toString();
    expect(url).toContain(expected);
  });

  test("--claimed-by <label> passes the label through verbatim", async () => {
    const client = mockClient();
    await runFeedbackList(client, { claimedBy: "hermes/groom" });
    const url = (client as never as { get: ReturnType<typeof vi.fn> }).get.mock.calls[0][0] as string;
    const expected = new URLSearchParams({ claimedBy: "hermes/groom" }).toString();
    expect(url).toContain(expected);
  });
});

/**
 * fb#616: claim leases were NOT mutually exclusive over MCP / POST
 * /api/cli/exec. buildChildEnv is a strict allow-list with no way to carry a
 * claim label, so resolveClaimId fell back to the App Service container's
 * user@host — ONE identical label for every hosted caller. Two agents both
 * matched `claimedBy = @by`, both took the renewal branch, and both got 200:
 * the lock was absent rather than weak, and `release --all` wiped everyone's.
 */
describe("claim identity — hosted callers (fb#616)", () => {
  const savedId = process.env.IB_CLAIM_ID;
  const savedShared = process.env.IB_CLAIM_ID_SHARED;
  beforeEach(() => {
    delete process.env.IB_CLAIM_ID;
    delete process.env.IB_CLAIM_ID_SHARED;
  });
  afterEach(() => {
    if (savedId === undefined) delete process.env.IB_CLAIM_ID; else process.env.IB_CLAIM_ID = savedId;
    if (savedShared === undefined) delete process.env.IB_CLAIM_ID_SHARED; else process.env.IB_CLAIM_ID_SHARED = savedShared;
  });

  test("the spawned child's IB_CLAIM_ID is used, so an MCP session is its own holder", async () => {
    process.env.IB_CLAIM_ID = "mcp:9f1c-42";
    const client = mockClient();
    await runFeedbackClaim(client, 42, {});
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
      "/api/feedback/42/claim",
      { by: "mcp:9f1c-42" },
      expect.any(Object)
    );
  });

  /**
   * THE FAIL-CLOSED GUARD. Without it the command succeeds and returns a lease
   * keyed on a label shared by every hosted caller — the caller believes it
   * holds the row exclusively and works it concurrently with whoever else
   * "holds" it. Refusing costs one round trip; accepting costs duplicated work
   * discovered from the diff.
   */
  test("refuses to claim when the backend could not derive an identity", async () => {
    process.env.IB_CLAIM_ID_SHARED = "1";
    const client = mockClient();
    await expect(runFeedbackClaim(client, 42, {})).rejects.toThrow(/would not actually lock/i);
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).not.toHaveBeenCalled();
  });

  test("--by satisfies the guard — the caller named itself explicitly", async () => {
    process.env.IB_CLAIM_ID_SHARED = "1";
    const client = mockClient();
    await runFeedbackClaim(client, 42, { by: "agent-7" });
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
      "/api/feedback/42/claim",
      { by: "agent-7" },
      expect.any(Object)
    );
  });

  test("IB_CLAIM_ID also satisfies it, so a normal hosted spawn is unaffected", async () => {
    process.env.IB_CLAIM_ID_SHARED = "1";
    process.env.IB_CLAIM_ID = "mcp:abc";
    const client = mockClient();
    await runFeedbackClaim(client, 42, {});
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalled();
  });

  test("release --all is guarded too — a shared label would drop other agents' claims", async () => {
    process.env.IB_CLAIM_ID_SHARED = "1";
    const client = mockClient();
    await expect(runFeedbackRelease(client, null, { all: true })).rejects.toThrow(/would not actually lock/i);
  });

  /**
   * Releasing ONE named id is safe under a shared label (you name the row), and
   * blocking it would strand work behind an identity problem — the guard is
   * scoped to the two commands whose purpose is exclusivity.
   */
  test("releasing a SINGLE id is still allowed under a shared label", async () => {
    process.env.IB_CLAIM_ID_SHARED = "1";
    const client = mockClient();
    await runFeedbackRelease(client, 42, {});
    expect((client as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalled();
  });

  test("the marker alone never blocks a LOCAL run — it is only set by the hosted bridge", async () => {
    const client = mockClient();
    await runFeedbackClaim(client, 42, {});
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalled();
  });
});

/**
 * The in-process half of fb#616. `IB_EXEC_INPROCESS=1` runs betonicli inside the
 * backend process, where every concurrent hosted call shares ONE `process.env` —
 * so an env-carried label would give them all the same identity, which is the
 * original bug wearing a different hat. The label therefore rides in the
 * per-call EmbeddedCtx, the same mechanism `tier` uses for the same reason.
 */
describe("claim identity — in-process ctx (fb#616)", () => {
  const saved = process.env.IB_CLAIM_ID;
  beforeEach(() => { delete process.env.IB_CLAIM_ID; });
  afterEach(() => { if (saved === undefined) delete process.env.IB_CLAIM_ID; else process.env.IB_CLAIM_ID = saved; });

  const ctx = (claimId: string | null) =>
    makeEmbeddedCtx({ token: "t", endpoint: "http://x", tier: "developer", claimId });

  test("the ctx label wins over the shared process env", async () => {
    process.env.IB_CLAIM_ID = "the-shared-container-label";
    const seen = await runEmbedded(ctx("mcp:per-caller"), async () => resolveClaimId(undefined));
    expect(seen).toBe("mcp:per-caller");
  });

  test("two interleaved ctxs keep their own identities", async () => {
    // The property the module-global/env approach could not provide.
    const [a, b] = await Promise.all([
      runEmbedded(ctx("agent-a"), async () => resolveClaimId(undefined)),
      runEmbedded(ctx("agent-b"), async () => resolveClaimId(undefined)),
    ]);
    expect([a, b]).toEqual(["agent-a", "agent-b"]);
  });

  test("an explicit --by still wins over the ctx", async () => {
    const seen = await runEmbedded(ctx("from-ctx"), async () => resolveClaimId("explicit"));
    expect(seen).toBe("explicit");
  });

  test("no ctx label falls through to the env, then to user@host", async () => {
    process.env.IB_CLAIM_ID = "from-env";
    expect(await runEmbedded(ctx(null), async () => resolveClaimId(undefined))).toBe("from-env");
    delete process.env.IB_CLAIM_ID;
    expect(await runEmbedded(ctx(null), async () => resolveClaimId(undefined))).toMatch(/@/);
  });
});

/**
 * fb#647: claiming a row that already carries changelog links must SAY so.
 *
 * This is the last moment before the wasted work starts. An open row can carry
 * links — `changelog add --feedback <id> --no-resolve` records a partial fix
 * without closing the row — and the claim response has always included them; it
 * simply never surfaced them, so the agent found out only after re-deriving the
 * shipped half by hand.
 */
describe("runFeedbackClaim — already-linked warning (fb#647)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => errSpy.mockRestore());

  const note = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  /** A claim client whose POST answers with the given row. */
  const clientReturning = (row: Record<string, unknown>) =>
    ({ post: vi.fn().mockResolvedValue(row) }) as never;

  test("THE BUG: a linked row warns, and names the entry to read first", async () => {
    await runFeedbackClaim(
      clientReturning({
        feedbackId: 418,
        claimedBy: "c6b96c",
        changelogLinks: [{ changelogId: 1189, role: "references" }],
      }),
      418,
      { by: "c6b96c" }
    );
    expect(note()).toMatch(/fb#418 already carries 1 changelog link/);
    expect(note()).toMatch(/cl#1189 \(references\)/);
    expect(note()).toMatch(/ib dev changelog get 1189/);
  });

  test("an unlinked row claims silently — no false alarm on the ordinary path", async () => {
    await runFeedbackClaim(
      clientReturning({ feedbackId: 42, claimedBy: "c6b96c", changelogLinks: [] }),
      42,
      { by: "c6b96c" }
    );
    expect(note()).not.toMatch(/changelog link/);
  });

  test("an older backend (no field) stays silent rather than asserting 'nothing shipped'", async () => {
    await runFeedbackClaim(clientReturning({ feedbackId: 42, claimedBy: "c6b96c" }), 42, { by: "c6b96c" });
    expect(note()).not.toMatch(/changelog link/);
  });

  test("several links are all named, pluralised", async () => {
    await runFeedbackClaim(
      clientReturning({
        feedbackId: 168,
        changelogLinks: [
          { changelogId: 900, role: "references" },
          { changelogId: 901, role: "resolves" },
        ],
      }),
      168,
      { by: "c6b96c" }
    );
    expect(note()).toMatch(/2 changelog links/);
    expect(note()).toMatch(/cl#900 \(references\), cl#901 \(resolves\)/);
  });

  test("the row is still returned unchanged — the note is stderr, not the payload", async () => {
    const row = { feedbackId: 418, changelogLinks: [{ changelogId: 1189, role: "references" }] };
    expect(await runFeedbackClaim(clientReturning(row), 418, { by: "c6b96c" })).toEqual(row);
  });
});
