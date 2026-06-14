import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runChatThreads,
  runChatThread,
  runChatList,
} from "../../src/commands/message/chat/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
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
