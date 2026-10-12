import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runSmsSend, runSmsList } from "../../src/commands/message/sms/index.js";

const client = mockApiClient();
beforeEach(() => {
  client.get.mockReset();
  client.post.mockReset();
});

describe("ib message sms send", () => {
  test("POSTs personId + message with write headers", async () => {
    client.post.mockResolvedValueOnce({ smsLogId: 1, status: "sent", segments: 1 });
    const out = await runSmsSend(client, { person: 9, message: "Moi", reason: "test" });
    expect(client.post).toHaveBeenCalledWith("/api/sms/send", { personId: 9, message: "Moi" }, expect.objectContaining({ headers: expect.any(Object) }));
    expect(client.post.mock.calls[0][2].headers["X-Action-Reason"]).toBe("test");
    expect(out).toEqual({ smsLogId: 1, status: "sent", segments: 1 });
  });
  test("--dry-run is forwarded as X-Dry-Run (server resolves the recipient)", async () => {
    client.post.mockResolvedValueOnce({ dryRun: true });
    await runSmsSend(client, { person: 9, message: "Moi", dryRun: true });
    const headers = client.post.mock.calls[0][2].headers;
    expect(headers["X-Dry-Run"]).toBeTruthy();
  });
});

describe("ib message sms list", () => {
  test("GETs the person history for the active company", async () => {
    client.get.mockResolvedValueOnce({ items: [{ smsLogId: 1 }] });
    const out = await runSmsList(client, { person: 9, owner: 27 });
    expect(client.get).toHaveBeenCalledWith("/api/sms/person/9/27");
    expect(out).toEqual({ items: [{ smsLogId: 1 }] });
  });
});
