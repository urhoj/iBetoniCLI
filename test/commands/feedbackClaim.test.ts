import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveClaimId,
  runFeedbackClaim,
  runFeedbackRelease,
} from "../../src/commands/feedback/index.js";
import { CliError, exitCodeFromStatus, hintForError } from "../../src/api/errors.js";
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
      "/api/feedback/42/claim?by=c6b96c"
    );
  });

  test("--all POSTs the bulk path instead", async () => {
    const client = mockClient();
    await runFeedbackRelease(client, null, { by: "c6b96c", all: true });
    expect((client as never as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
      "/api/feedback/claims/release",
      { by: "c6b96c" }
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
