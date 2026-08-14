import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveClaimId,
  runFeedbackClaim,
  runFeedbackRelease,
} from "../../src/commands/feedback/index.js";

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
