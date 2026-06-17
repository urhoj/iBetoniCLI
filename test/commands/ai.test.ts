import { describe, test, expect, vi, beforeEach } from "vitest";
import { runAiConversation, runAiConversationList } from "../../src/commands/ai/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const get = mockClient.get as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset();
});

describe("ib ai conversation", () => {
  test("GETs /api/cli/ai/conversation/:id and returns the transcript", async () => {
    get.mockResolvedValueOnce({ conversationId: 55, messageCount: 2, messages: [] });
    const out = await runAiConversation(mockClient, 55);
    expect(get).toHaveBeenCalledWith("/api/cli/ai/conversation/55");
    expect(out).toMatchObject({ conversationId: 55, messageCount: 2 });
  });

  test("rejects non-positive / non-integer ids (exit 4), no GET", async () => {
    for (const bad of [0, -1, NaN, 4.5]) {
      await expect(runAiConversation(mockClient, bad)).rejects.toMatchObject({ exitCode: 4 });
    }
    expect(get).not.toHaveBeenCalled();
  });
});

describe("ib ai conversations", () => {
  test("GETs /api/cli/ai/conversations with default limit and wraps in a ListEnvelope", async () => {
    get.mockResolvedValueOnce({
      items: [
        { conversationId: 55, personId: 6233, ownerAsiakasId: 777, entryTime: "2026-06-17T08:00:00Z", messageCount: 4 },
      ],
    });
    const out = await runAiConversationList(mockClient);
    expect(get).toHaveBeenCalledWith("/api/cli/ai/conversations?limit=20");
    expect(out).toMatchObject({ count: 1, nextCursor: null, truncated: false });
    expect(out.items[0]).toMatchObject({ conversationId: 55, messageCount: 4 });
  });

  test("passes --limit and --person through; truncated true when page fills the limit", async () => {
    get.mockResolvedValueOnce({
      items: [
        { conversationId: 1, personId: 6233, ownerAsiakasId: 777, entryTime: "x", messageCount: 1 },
        { conversationId: 2, personId: 6233, ownerAsiakasId: 777, entryTime: "x", messageCount: 1 },
      ],
    });
    const out = await runAiConversationList(mockClient, { limit: 2, personId: 6233 });
    expect(get).toHaveBeenCalledWith("/api/cli/ai/conversations?limit=2&personId=6233");
    expect(out.truncated).toBe(true);
  });

  test("tolerates a missing items array (empty list)", async () => {
    get.mockResolvedValueOnce({});
    const out = await runAiConversationList(mockClient, { limit: 5 });
    expect(out).toMatchObject({ items: [], count: 0, truncated: false });
  });

  test("rejects out-of-range limit and bad personId (exit 4), no GET", async () => {
    for (const bad of [0, -1, 101, NaN, 4.5]) {
      await expect(runAiConversationList(mockClient, { limit: bad })).rejects.toMatchObject({ exitCode: 4 });
    }
    await expect(runAiConversationList(mockClient, { personId: 0 })).rejects.toMatchObject({ exitCode: 4 });
    expect(get).not.toHaveBeenCalled();
  });
});
