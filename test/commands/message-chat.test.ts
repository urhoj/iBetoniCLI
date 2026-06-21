import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runChatThreads,
  runChatThread,
  runChatList,
  runChatSend,
  runChatMarkRead,
  runChatDelete,
  runChatEdit,
} from "../../src/commands/message/chat/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const asGet = () => mockClient.get as ReturnType<typeof vi.fn>;

const THREADS = [
  { threadId: 10, contextType: "pumppuRequest", contextId: 23, unreadCount: 0 },
  { threadId: 11, contextType: "pumppuRequest", contextId: 23, unreadCount: 3 },
  { threadId: 12, contextType: "pumppuRequest", contextId: 99, unreadCount: 1 },
];

describe("runChatThreads", () => {
  beforeEach(() => asGet().mockReset());

  test("wraps /threads/mine into the list envelope", async () => {
    asGet().mockResolvedValueOnce(THREADS);
    const res = await runChatThreads(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/mine");
    expect(res).toEqual({ items: THREADS, nextCursor: null, count: 3 });
  });

  test("--tarjous filters by contextId", async () => {
    asGet().mockResolvedValueOnce(THREADS);
    const res = await runChatThreads(mockClient, { tarjous: 23 });
    expect(res.count).toBe(2);
    expect(res.items.every((t) => (t as { contextId: number }).contextId === 23)).toBe(true);
  });

  test("--unread filters to unreadCount > 0", async () => {
    asGet().mockResolvedValueOnce(THREADS);
    const res = await runChatThreads(mockClient, { unread: true });
    expect(res.count).toBe(2);
  });
});

describe("runChatThread", () => {
  beforeEach(() => asGet().mockReset());
  test("GETs the thread meta endpoint", async () => {
    asGet().mockResolvedValueOnce({ thread: { threadId: 42 }, participants: [] });
    await runChatThread(mockClient, 42);
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/42");
  });
});

describe("runChatList", () => {
  beforeEach(() => asGet().mockReset());

  test("wraps messages into the list envelope, no query string by default", async () => {
    asGet().mockResolvedValueOnce([{ messageId: 1 }, { messageId: 2 }]);
    const res = await runChatList(mockClient, 42, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/42/messages");
    expect(res.count).toBe(2);
  });

  test("passes --since and --limit as query params", async () => {
    asGet().mockResolvedValueOnce([]);
    await runChatList(mockClient, 42, { since: "2026-06-14T10:00:00Z", limit: 20 });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/messages/threads/42/messages?since=2026-06-14T10%3A00%3A00Z&limit=20"
    );
  });
});

describe("runChatSend", () => {
  const asPost = () => mockClient.post as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    asGet().mockReset();
    asPost().mockReset();
  });

  test("--dry-run previews recipients via a GET and never POSTs", async () => {
    asGet().mockResolvedValueOnce({
      thread: { threadId: 42 },
      participants: [
        { personId: 6233, personFirstName: "Kalle", personLastName: "Urho", role: "customer" },
        { personId: 10, personFirstName: "Pia", personLastName: "Pumppu", role: "pumppu" },
      ],
    });
    const res = (await runChatSend(mockClient, 42, {
      body: "hei",
      source: "cli",
      dryRun: true,
    })) as { dryRun: boolean; wouldSend: { recipients: unknown[]; source: string } };
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/42");
    expect(mockClient.post).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    expect(res.wouldSend.source).toBe("cli");
    expect(res.wouldSend.recipients).toHaveLength(2);
  });

  test("a real send POSTs body + source (+ sourceNote when reason given)", async () => {
    asPost().mockResolvedValueOnce({ messageId: 7, threadId: 42 });
    await runChatSend(mockClient, 42, { body: "hei", source: "ai", reason: "auto-reply" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/messages/threads/42/messages",
      { body: "hei", source: "ai", sourceNote: "auto-reply" },
      { headers: { "X-Action-Reason": "auto-reply" } }
    );
  });

  test("omits sourceNote when no reason", async () => {
    asPost().mockResolvedValueOnce({ messageId: 8 });
    await runChatSend(mockClient, 42, { body: "moi", source: "cli" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/messages/threads/42/messages",
      { body: "moi", source: "cli" },
      { headers: {} }
    );
  });

  test("forwards --idempotency-key as the Idempotency-Key header", async () => {
    asPost().mockResolvedValueOnce({ messageId: 9 });
    await runChatSend(mockClient, 42, { body: "x", source: "cli", idempotencyKey: "abc-123" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/messages/threads/42/messages",
      { body: "x", source: "cli" },
      { headers: { "Idempotency-Key": "abc-123" } }
    );
  });
});

describe("runChatMarkRead", () => {
  const asPost = () => mockClient.post as ReturnType<typeof vi.fn>;
  beforeEach(() => asPost().mockReset());
  test("POSTs to the read endpoint with an empty body", async () => {
    asPost().mockResolvedValueOnce({ lastReadAt: "2026-06-14T12:00:00Z" });
    await runChatMarkRead(mockClient, 42);
    expect(mockClient.post).toHaveBeenCalledWith("/api/messages/threads/42/read", {});
  });
});

describe("runChatDelete", () => {
  const asDelete = () => mockClient.delete as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    asGet().mockReset();
    asDelete().mockReset();
  });

  test("a real delete DELETEs the message with write headers", async () => {
    asDelete().mockResolvedValueOnce({ messageId: 7, threadId: 42, deleted: true });
    await runChatDelete(mockClient, 42, 7, { reason: "cleanup", idempotencyKey: "k1" });
    expect(mockClient.delete).toHaveBeenCalledWith("/api/messages/threads/42/messages/7", {
      headers: { "Idempotency-Key": "k1", "X-Action-Reason": "cleanup" },
    });
  });

  test("a real delete with no write flags sends empty headers", async () => {
    asDelete().mockResolvedValueOnce({ deleted: true });
    await runChatDelete(mockClient, 42, 7, {});
    expect(mockClient.delete).toHaveBeenCalledWith("/api/messages/threads/42/messages/7", {
      headers: {},
    });
  });

  test("--dry-run lists the thread and returns wouldDelete, never DELETEs", async () => {
    asGet().mockResolvedValueOnce([
      { messageId: 7, body: "hei", senderPersonId: 10 },
      { messageId: 8, body: "moi", senderPersonId: 10 },
    ]);
    const res = (await runChatDelete(mockClient, 42, 7, { dryRun: true })) as {
      dryRun: boolean;
      threadId: number;
      wouldDelete: { messageId: number; body: unknown; senderPersonId: unknown };
    };
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/42/messages");
    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    expect(res.threadId).toBe(42);
    expect(res.wouldDelete).toEqual({ messageId: 7, body: "hei", senderPersonId: 10 });
  });

  test("--dry-run on a missing message throws exit 5", async () => {
    asGet().mockResolvedValueOnce([{ messageId: 8, body: "moi" }]);
    await expect(
      runChatDelete(mockClient, 42, 999, { dryRun: true })
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(mockClient.delete).not.toHaveBeenCalled();
  });
});

describe("runChatEdit", () => {
  const asPatch = () => mockClient.patch as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    asGet().mockReset();
    asPatch().mockReset();
  });

  test("a real edit PATCHes body + write headers", async () => {
    asPatch().mockResolvedValueOnce({ messageId: 7, threadId: 42, body: "uusi", editedAt: "x" });
    await runChatEdit(mockClient, 42, 7, { body: "uusi", reason: "fix typo" });
    expect(mockClient.patch).toHaveBeenCalledWith(
      "/api/messages/threads/42/messages/7",
      { body: "uusi" },
      { headers: { "X-Action-Reason": "fix typo" } }
    );
  });

  test("--dry-run lists the thread + returns wouldEdit diff, never PATCHes", async () => {
    asGet().mockResolvedValueOnce([{ messageId: 7, body: "vanha" }]);
    const res = (await runChatEdit(mockClient, 42, 7, { body: "uusi", dryRun: true })) as {
      dryRun: boolean;
      wouldEdit: { messageId: number; from: unknown; to: string };
    };
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/42/messages");
    expect(mockClient.patch).not.toHaveBeenCalled();
    expect(res.wouldEdit).toEqual({ messageId: 7, from: "vanha", to: "uusi" });
  });

  test("--dry-run on a missing message exits 5", async () => {
    asGet().mockResolvedValueOnce([{ messageId: 8, body: "x" }]);
    await expect(
      runChatEdit(mockClient, 42, 999, { body: "uusi", dryRun: true })
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});
