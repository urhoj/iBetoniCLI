import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runThreadArchive, runThreadReopen, runThreadRename,
  runThreadParticipantAdd, runThreadParticipantRemove,
} from "../../src/commands/message/thread/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() } as unknown as ApiClient;

describe("ib message thread run fns", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); (mockClient.patch as ReturnType<typeof vi.fn>).mockReset(); (mockClient.delete as ReturnType<typeof vi.fn>).mockReset(); });

  test("archive POSTs to /archive with reason header", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ threadId: 3, archived: true });
    await runThreadArchive(mockClient, 3, { reason: "done" });
    expect(mockClient.post).toHaveBeenCalledWith("/api/messages/threads/3/archive", {}, { headers: { "X-Action-Reason": "done" } });
  });
  test("reopen POSTs to /reopen", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ threadId: 3, archived: false });
    await runThreadReopen(mockClient, 3, {});
    expect(mockClient.post).toHaveBeenCalledWith("/api/messages/threads/3/reopen", {}, { headers: {} });
  });
  test("rename PATCHes title", async () => {
    (mockClient.patch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ threadId: 3, title: "X" });
    await runThreadRename(mockClient, 3, "X", {});
    expect(mockClient.patch).toHaveBeenCalledWith("/api/messages/threads/3", { title: "X" }, { headers: {} });
  });
  test("participant add POSTs personId + role", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ added: true });
    await runThreadParticipantAdd(mockClient, 3, 42, { role: "pumppu" });
    expect(mockClient.post).toHaveBeenCalledWith("/api/messages/threads/3/participants", { personId: 42, role: "pumppu" }, { headers: {} });
  });
  test("participant remove DELETEs by personId", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ removed: true });
    await runThreadParticipantRemove(mockClient, 3, 42, {});
    expect(mockClient.delete).toHaveBeenCalledWith("/api/messages/threads/3/participants/42", { headers: {} });
  });
});
