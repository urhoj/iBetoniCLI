import { describe, test, expect, vi, beforeEach } from "vitest";
import { runAiConversation } from "../../src/commands/ai/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

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

  test("rejects a non-positive / non-integer id (exit 4), no GET", async () => {
    await expect(runAiConversation(mockClient, 0)).rejects.toMatchObject({ exitCode: 4 });
    await expect(runAiConversation(mockClient, NaN)).rejects.toThrowError(CliError);
    expect(get).not.toHaveBeenCalled();
  });
});
