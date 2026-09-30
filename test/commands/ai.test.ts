import { describe, test, expect, beforeEach, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runAiAsk, runAiConversation, runAiConversationList } from "../../src/commands/ai/index.js";

const mockClient = mockApiClient();

const get = mockClient.get;
const post = mockClient.post;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe("ib ai ask", () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  test("POSTs /api/ai/ask and projects msg, dropping msgData", async () => {
    post.mockResolvedValueOnce({
      msg: { message: "Hei!", conversationId: 7, msgData: [{ role: "user" }], usage, provider: "bedrock", model: "eu.x" },
    });
    const out = await runAiAsk(mockClient, "Hei", { provider: "bedrock", conversationId: 7, keikkaId: 9 });
    expect(post).toHaveBeenCalledWith("/api/ai/ask", {
      prompt: "Hei",
      conversationId: 7,
      keikkaId: 9,
      provider: "bedrock",
    });
    expect(out).toEqual({ text: "Hei!", provider: "bedrock", model: "eu.x", usage, conversationId: 7 });
  });

  test("surfaces pendingAction and never calls /api/ai/confirm", async () => {
    const pendingAction = { toolCallId: "t1", argv: ["keikka", "update"], label: "x", command: "ib keikka update" };
    post.mockResolvedValueOnce({ msg: { message: "Vahvistatko?", conversationId: 8, usage, provider: "anthropic", pendingAction } });
    const out = await runAiAsk(mockClient, "Muuta keikkaa");
    expect(out.pendingAction).toEqual(pendingAction);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/api/ai/ask");
  });

  test("flags a silent provider fallback (stderr + requestedProvider)", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    post.mockResolvedValueOnce({ msg: { message: "ok", conversationId: 1, usage, provider: "openai-compat" } });
    const out = await runAiAsk(mockClient, "Hei", { provider: "bedrock" });
    expect(out).toMatchObject({ provider: "openai-compat", requestedProvider: "bedrock" });
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("--provider bedrock was not used");
    stderr.mockRestore();
  });

  test("--dry-run returns the body without sending", async () => {
    const out = await runAiAsk(mockClient, "Hei", { dryRun: true });
    expect(out).toMatchObject({ dryRun: true, wouldSend: { method: "POST", path: "/api/ai/ask" } });
    expect(post).not.toHaveBeenCalled();
  });

  test("rejects an empty prompt and an unknown provider (exit 4), no POST", async () => {
    await expect(runAiAsk(mockClient, "  ")).rejects.toMatchObject({ exitCode: 4 });
    await expect(runAiAsk(mockClient, "Hei", { provider: "gpt" })).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });
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
