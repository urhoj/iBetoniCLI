import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runSmsSend, runSmsList, runSmsLog } from "../../src/commands/message/sms/index.js";

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

describe("ib message sms log (fb#2534)", () => {
  const TOTALS = { smsCount: 1, smsSegments: 2, segmentPriceEur: 0.055, estimatedEur: 0.11 };
  test("GETs the company log with range + channel and returns a list envelope with totals", async () => {
    client.get.mockResolvedValueOnce({ items: [{ smsLogId: 1 }], totals: TOTALS });
    const out = await runSmsLog(client, { owner: 27, from: "2026-10-01", to: "2026-10-26", channel: "sms" });
    expect(client.get).toHaveBeenCalledWith("/api/sms/log/27?from=2026-10-01&to=2026-10-26&channel=sms");
    expect(out).toEqual({ items: [{ smsLogId: 1 }], nextCursor: null, count: 1, truncated: false, totals: TOTALS });
  });
  test("no flags -> server defaults (no query string)", async () => {
    client.get.mockResolvedValueOnce({ items: [], totals: TOTALS });
    await runSmsLog(client, { owner: 27 });
    expect(client.get).toHaveBeenCalledWith("/api/sms/log/27");
  });
});
