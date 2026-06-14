import { describe, test, expect, vi, beforeEach } from "vitest";
import { resolveThreadId } from "../../src/commands/message/chat/resolveThread.js";
import { CliError } from "../../src/api/errors.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const asGet = () => mockClient.get as ReturnType<typeof vi.fn>;

const MINE = [
  { threadId: 10, contextType: "pumppuRequest", contextId: 23, ownerAsiakasId: 100 },
  { threadId: 11, contextType: "pumppuRequest", contextId: 23, ownerAsiakasId: 200 },
  { threadId: 12, contextType: "pumppuRequest", contextId: 99, ownerAsiakasId: 100 },
];

describe("resolveThreadId", () => {
  beforeEach(() => asGet().mockReset());

  test("returns a raw threadId without any network call", async () => {
    expect(await resolveThreadId(mockClient, { thread: 42 })).toBe(42);
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("resolves a unique --tarjous match to its threadId", async () => {
    asGet().mockResolvedValueOnce(MINE);
    expect(await resolveThreadId(mockClient, { tarjous: 99 })).toBe(12);
    expect(mockClient.get).toHaveBeenCalledWith("/api/messages/threads/mine");
  });

  test("exit 4 when neither threadId nor --tarjous is given", async () => {
    await expect(resolveThreadId(mockClient, {})).rejects.toMatchObject({
      statusCode: 0,
    });
    await expect(resolveThreadId(mockClient, {})).rejects.toBeInstanceOf(CliError);
  });

  test("exit 5 when --tarjous matches no thread", async () => {
    asGet().mockResolvedValue(MINE);
    await expect(resolveThreadId(mockClient, { tarjous: 555 })).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  test("exit 4 listing threadIds when --tarjous is ambiguous", async () => {
    asGet().mockResolvedValue(MINE);
    await expect(resolveThreadId(mockClient, { tarjous: 23 })).rejects.toMatchObject({
      exitCode: 4,
    });
    await expect(resolveThreadId(mockClient, { tarjous: 23 })).rejects.toThrow(/10.*11|11.*10/);
  });
});
