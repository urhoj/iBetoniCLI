import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { registerMessageDriverCommands, runDriverChannels, runDriverSend } from "../../src/commands/message/driver/index.js";

vi.mock("../../src/output/json.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/output/json.js")>(),
  writeJson: vi.fn(),
  exitWithError: (error: unknown) => { throw error; },
}));

const client = mockApiClient();
beforeEach(() => vi.resetAllMocks());

describe("ib message driver send", () => {
  test.each(["push", "email"] as const)("POSTs %s with all write headers", async (channel) => {
    const result = { dryRun: true, personId: 9, channel, target: channel === "push" ? "push" : "m***@example.fi" };
    client.post.mockResolvedValueOnce(result);
    expect(await runDriverSend(client, {
      person: 9, channel, message: "Moi", subject: "Aikataulu",
      dryRun: true, reason: "Requested by dispatcher", idempotencyKey: "send-9",
    })).toEqual(result);
    expect(client.post).toHaveBeenCalledWith("/api/sms/message", {
      personId: 9, channel, message: "Moi", subject: "Aikataulu",
    }, { headers: {
      "X-Dry-Run": "1", "X-Action-Reason": "Requested by dispatcher", "Idempotency-Key": "send-9",
    } });
  });

  test("omits an unspecified subject so the server applies its default", async () => {
    await runDriverSend(client, { person: 9, channel: "push", message: "Moi" });
    expect(client.post).toHaveBeenCalledWith("/api/sms/message", {
      personId: 9, channel: "push", message: "Moi",
    }, { headers: {} });
  });

  test("propagates send failures without a success-shaped fallback", async () => {
    const error = new Error("Send failed");
    client.post.mockRejectedValueOnce(error);
    await expect(runDriverSend(client, { person: 9, channel: "email", message: "Moi" })).rejects.toBe(error);
  });

  test.each(["sms", "EMAIL", "unknown"])("rejects channel %s before resolving a client", async (channel) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    const getClient = vi.fn(async () => client);
    registerMessageDriverCommands(program, getClient);
    await expect(program.parseAsync(["driver", "send", "--person", "9", "--channel", channel, "--message", "Moi"], { from: "user" }))
      .rejects.toMatchObject({ code: "commander.invalidArgument" });
    expect(getClient).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  test("reads quotes and newlines from JSON, with explicit flags taking precedence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-driver-message-"));
    const file = join(dir, "message.json");
    const message = 'Meet at "Gate 2"\nBring the schedule.';
    try {
      writeFileSync(file, JSON.stringify({ person: 9, channel: "email", message, subject: "Original" }));
      const program = new Command().exitOverride();
      registerMessageDriverCommands(program, async () => client);
      await program.parseAsync(["driver", "send", "--from-json", file, "--subject", "Override", "--dry-run"], { from: "user" });
      expect(client.post).toHaveBeenCalledWith("/api/sms/message", {
        personId: 9, channel: "email", message, subject: "Override",
      }, { headers: { "X-Dry-Run": "1" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { person: 9, channel: "sms", message: "Moi" },
    { person: -1, channel: "push", message: "Moi" },
    { person: 9, channel: "push" },
    { person: 9, channel: "push", message: "Moi", dryRun: true },
  ])("rejects invalid JSON payload %j without sending", async (payload) => {
    const dir = mkdtempSync(join(tmpdir(), "ib-driver-message-"));
    const file = join(dir, "message.json");
    try {
      writeFileSync(file, JSON.stringify(payload));
      const program = new Command().exitOverride();
      registerMessageDriverCommands(program, async () => client);
      await expect(program.parseAsync(["driver", "send", "--from-json", file], { from: "user" }))
        .rejects.toMatchObject({ exitCode: 4 });
      expect(client.post).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ib message driver channels", () => {
  test.each([27, 28])("uses active company %i from the token", async (owner) => {
    client.getCurrentToken.mockReturnValue(`e30.${Buffer.from(JSON.stringify({ ownerAsiakasId: owner })).toString("base64url")}.sig`);
    const result = { pushDevices: 2, email: "m@example.fi" };
    client.get.mockResolvedValueOnce(result);
    expect(await runDriverChannels(client, { person: 9 })).toEqual(result);
    expect(client.get).toHaveBeenCalledExactlyOnceWith(`/api/sms/channels/9/${owner}`);
  });

  test("propagates a tenant-scoped not-found error", async () => {
    client.getCurrentToken.mockReturnValue(`e30.${Buffer.from(JSON.stringify({ ownerAsiakasId: 27 })).toString("base64url")}.sig`);
    const error = new Error("Not found");
    client.get.mockRejectedValueOnce(error);
    await expect(runDriverChannels(client, { person: 99 })).rejects.toBe(error);
  });
});
