import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  registerMessageDriverCommands, runDriverChannels, runDriverSend,
  runDriverDayText, runDriverDaySend, runDriverDayStatus,
} from "../../src/commands/message/driver/index.js";
import { addDaysISO, todayHelsinki } from "../../src/dates.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

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

const tokenFor = (owner: number) => `e30.${Buffer.from(JSON.stringify({ ownerAsiakasId: owner })).toString("base64url")}.sig`;
const TOMORROW = () => addDaysISO(todayHelsinki(), 1);

describe("ib message driver day-text", () => {
  test("GETs the day text of the active company; --date defaults to tomorrow (Helsinki)", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    const day = { text: "To 22.10. 81:", sig: "ab12", vehicleId: 53, keikkaCount: 1, palkkiCount: 0, pref: null, channel: "sms", fallback: false };
    client.get.mockResolvedValueOnce(day);
    expect(await runDriverDayText(client, { person: 9 })).toEqual(day);
    expect(client.get).toHaveBeenCalledExactlyOnceWith(`/api/sms/day-text/9/27?pvm=${TOMORROW()}`);
  });

  test("expands date aliases and passes an ISO date through", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(28));
    client.get.mockResolvedValue({});
    await runDriverDayText(client, { person: 9, date: "today" });
    expect(client.get).toHaveBeenLastCalledWith(`/api/sms/day-text/9/28?pvm=${todayHelsinki()}`);
    await runDriverDayText(client, { person: 9, date: "2026-10-23" });
    expect(client.get).toHaveBeenLastCalledWith("/api/sms/day-text/9/28?pvm=2026-10-23");
  });

  test.each(["20261022", "22.10.2026", "x"])("rejects --date %s locally (exit 4), no request", async (date) => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    await expect(runDriverDayText(client, { person: 9, date })).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("ib message driver day-send", () => {
  test("with --channel: POSTs source ib, the ISO day and the write headers; no day-text read", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    client.post.mockResolvedValueOnce({ smsLogId: 21, status: "sent", segments: 2, phone: "***4567" });
    const out = await runDriverDaySend(client, {
      person: 9, date: "2026-10-22", channel: "sms", dryRun: true, reason: "dispatcher asked", idempotencyKey: "day-9",
    });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/sms/day-message", {
      personId: 9, pvm: "2026-10-22", channel: "sms", source: "ib",
    }, { headers: { "X-Dry-Run": "1", "X-Action-Reason": "dispatcher asked", "Idempotency-Key": "day-9" } });
    expect(out).toEqual({ channel: "sms", smsLogId: 21, status: "sent", segments: 2, phone: "***4567" });
  });

  test("an override --message and --subject ride along; omitted they stay out (the server builds the text)", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    client.post.mockResolvedValue({ status: "sent" });
    await runDriverDaySend(client, { person: 9, date: "2026-10-22", channel: "email", message: "Muutettu teksti", subject: "Huomenna" });
    expect(client.post).toHaveBeenLastCalledWith("/api/sms/day-message", {
      personId: 9, pvm: "2026-10-22", channel: "email", source: "ib", message: "Muutettu teksti", subject: "Huomenna",
    }, { headers: {} });
  });

  test("without --channel: uses the channel the server resolves (the driver's preference, like the dialog), date tomorrow", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    client.get.mockResolvedValueOnce({ text: "Pe 23.10. 81:", channel: "push", fallback: true, pref: "email" });
    client.post.mockResolvedValueOnce({ status: "sent", channel: "push", target: "push" });
    const out = await runDriverDaySend(client, { person: 9 });
    expect(client.get).toHaveBeenCalledExactlyOnceWith(`/api/sms/day-text/9/27?pvm=${TOMORROW()}`);
    expect(client.post).toHaveBeenCalledWith("/api/sms/day-message", expect.objectContaining({ channel: "push", pvm: TOMORROW(), source: "ib" }), { headers: {} });
    expect(out).toMatchObject({ channel: "push", status: "sent" });
  });

  test("without --channel and nothing reaches the driver: exit 4, nothing sent", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    client.get.mockResolvedValueOnce({ text: "Pe 23.10. 81:", channel: null, fallback: false });
    await expect(runDriverDaySend(client, { person: 9 })).rejects.toMatchObject({ exitCode: 4 });
    expect(client.post).not.toHaveBeenCalled();
  });

  test("an empty day with no --message: exit 4, nothing sent", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    client.get.mockResolvedValueOnce({ text: "", channel: "sms" });
    await expect(runDriverDaySend(client, { person: 9 })).rejects.toMatchObject({ exitCode: 4 });
    expect(client.post).not.toHaveBeenCalled();
  });

  test.each(["whatsapp", "SMS", "x"])("rejects --channel %s at parse time, before resolving a client", async (channel) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    const getClient = vi.fn(async () => client);
    registerMessageDriverCommands(program, getClient);
    await expect(program.parseAsync(["driver", "day-send", "--person", "9", "--channel", channel], { from: "user" }))
      .rejects.toMatchObject({ code: "commander.invalidArgument" });
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("ib message driver day-status", () => {
  test("lists the day's attempts of the active company as a list envelope; --date defaults to tomorrow", async () => {
    client.getCurrentToken.mockReturnValue(tokenFor(27));
    const row = { personId: 9, pvm: 20261022, status: "sent", channel: "sms", source: "grid" };
    client.get.mockResolvedValueOnce({ items: [row] });
    expect(await runDriverDayStatus(client, {})).toEqual({ items: [row], nextCursor: null, count: 1 });
    expect(client.get).toHaveBeenCalledExactlyOnceWith(`/api/sms/day-messages/27?pvm=${TOMORROW()}`);
  });
});

describe("day-message specs", () => {
  test.each(["ib message driver day-text", "ib message driver day-send", "ib message driver day-status"])("%s has a spec with a client date row and server rows", (command) => {
    const spec = COMMAND_SPECS.find((s) => s.command === command);
    expect(spec).toBeDefined();
    expect(spec!.errors!.some((e) => "origin" in e && e.origin === "client" && e.exit === 4)).toBe(true);
    expect(spec!.errors!.some((e) => "http" in e && e.http === 403)).toBe(true);
  });

  test("message sms send no longer says the AI bridges refuse it (owner ruling 2026-10-21)", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib message sms send")!;
    const text = JSON.stringify(spec.notes);
    expect(text).not.toMatch(/Never automate|refuses it over MCP/);
    expect(text).toContain("2026-10-21");
  });
});
