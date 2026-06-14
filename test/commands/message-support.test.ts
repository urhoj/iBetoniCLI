import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSupportInbox,
  runSupportContact,
  runSupportResolve,
} from "../../src/commands/message/support/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const get = mockClient.get as ReturnType<typeof vi.fn>;
const post = mockClient.post as ReturnType<typeof vi.fn>;
const patch = mockClient.patch as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
});

// ─── inbox ───────────────────────────────────────────────────────────────────

describe("ib message support inbox", () => {
  test("defaults status=open and projects to the list envelope", async () => {
    get.mockResolvedValueOnce({ items: [{ threadId: 1 }, { threadId: 2 }], count: 2, truncated: false });
    const out = await runSupportInbox(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/messages/support/inbox?status=open");
    expect(out).toEqual({
      items: [{ threadId: 1 }, { threadId: 2 }],
      nextCursor: null,
      count: 2,
      truncated: false,
    });
  });

  test("forwards status + limit query params and truncated flag", async () => {
    get.mockResolvedValueOnce({ items: [{ threadId: 3 }], count: 9, truncated: true });
    const out = await runSupportInbox(mockClient, { status: "all", limit: 5 });
    expect(get).toHaveBeenCalledWith("/api/messages/support/inbox?status=all&limit=5");
    expect(out).toMatchObject({ count: 9, truncated: true });
  });

  test("a bad --status exits 4, no GET", async () => {
    await expect(runSupportInbox(mockClient, { status: "bogus" })).rejects.toMatchObject({
      exitCode: 4,
    });
    await expect(runSupportInbox(mockClient, { status: "bogus" })).rejects.toBeInstanceOf(CliError);
    expect(get).not.toHaveBeenCalled();
  });
});

// ─── contact ─────────────────────────────────────────────────────────────────

describe("ib message support contact", () => {
  test("POSTs the correct body for a pumppuRequest context", async () => {
    post.mockResolvedValueOnce({ threadId: 7, message: { messageId: 1 } });
    const out = await runSupportContact(mockClient, {
      contextType: "pumppuRequest",
      contextId: 23,
      body: "  provider not responding  ",
    });
    expect(post).toHaveBeenCalledWith("/api/messages/support", {
      contextType: "pumppuRequest",
      contextId: 23,
      body: "provider not responding",
    });
    expect(out).toEqual({ threadId: 7, message: { messageId: 1 } });
  });

  test("POSTs as a REAL write (no meta flag → respects the read-only lock)", async () => {
    post.mockResolvedValueOnce({ threadId: 8 });
    await runSupportContact(mockClient, { contextType: "keikka", contextId: 5012, body: "x" });
    // third arg (options) must be undefined — NOT { meta: true }
    expect(post.mock.calls[0][2]).toBeUndefined();
  });

  test("--dry-run prints the payload and never POSTs", async () => {
    const out = await runSupportContact(mockClient, {
      contextType: "keikka",
      contextId: 5012,
      body: "wrong worksite",
      dryRun: true,
    });
    expect(post).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: {
        method: "POST",
        path: "/api/messages/support",
        body: { contextType: "keikka", contextId: 5012, body: "wrong worksite" },
      },
    });
  });

  test("empty body exits 4, no POST", async () => {
    await expect(
      runSupportContact(mockClient, { contextType: "keikka", contextId: 1, body: "   " })
    ).rejects.toThrowError(CliError);
    expect(post).not.toHaveBeenCalled();
  });

  test("bad contextType exits 4, no POST", async () => {
    await expect(
      runSupportContact(mockClient, { contextType: "nonsense", contextId: 1, body: "x" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  test("non-numeric context exits 4, no POST", async () => {
    await expect(
      runSupportContact(mockClient, { contextType: "pumppuRequest", contextId: NaN, body: "x" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });
});

// ─── resolve ─────────────────────────────────────────────────────────────────

describe("ib message support resolve", () => {
  test("PATCHes { status: 'resolved' } by default", async () => {
    patch.mockResolvedValueOnce({ threadId: 42, status: "resolved" });
    const out = await runSupportResolve(mockClient, 42, {});
    expect(patch).toHaveBeenCalledWith("/api/messages/support/42/status", { status: "resolved" });
    expect(out).toEqual({ threadId: 42, status: "resolved" });
  });

  test("--reopen PATCHes { status: 'open' }", async () => {
    patch.mockResolvedValueOnce({ threadId: 42, status: "open" });
    await runSupportResolve(mockClient, 42, { reopen: true });
    expect(patch).toHaveBeenCalledWith("/api/messages/support/42/status", { status: "open" });
  });

  test("--dry-run previews the PATCH body and never sends", async () => {
    const out = await runSupportResolve(mockClient, 42, { dryRun: true });
    expect(patch).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: {
        method: "PATCH",
        path: "/api/messages/support/42/status",
        body: { status: "resolved" },
      },
    });
  });

  test("a non-numeric threadId exits 4, no PATCH", async () => {
    await expect(runSupportResolve(mockClient, Number("abc"), {})).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(patch).not.toHaveBeenCalled();
  });
});
