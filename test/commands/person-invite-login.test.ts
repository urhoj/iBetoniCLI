import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runInviteLogin } from "../../src/commands/person/inviteLogin.js";

const client = mockApiClient();
beforeEach(() => client.post.mockReset());

describe("ib person invite-login (fb#2959)", () => {
  test("POSTs the person with orders on, force off, no channel by default, plus write headers", async () => {
    client.post.mockResolvedValueOnce({ channel: "sms", status: "sent" });
    const out = await runInviteLogin(client, 9, { reason: "new driver" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/sms/invite-login",
      { personId: 9, channel: undefined, orders: true, message: undefined, force: false },
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(client.post.mock.calls[0][2].headers["X-Action-Reason"]).toBe("new driver");
    expect(out).toEqual({ channel: "sms", status: "sent" });
  });

  test("--no-orders / --channel / --message / --force reach the body; --dry-run is X-Dry-Run", async () => {
    client.post.mockResolvedValueOnce({ dryRun: true });
    await runInviteLogin(client, 9, { orders: false, channel: "email", message: "Moi", force: true, dryRun: true });
    expect(client.post.mock.calls[0][1]).toEqual({ personId: 9, channel: "email", orders: false, message: "Moi", force: true });
    expect(client.post.mock.calls[0][2].headers["X-Dry-Run"]).toBeTruthy();
  });
});
