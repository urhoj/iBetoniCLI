import { Command } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  DAY_MESSAGE_CHANNEL_TYPE_ID,
  DAY_MESSAGE_CHANNELS,
  registerPersonDayMessageChannelCommands,
  runDayMessageChannelGet,
  runDayMessageChannelSet,
} from "../../src/commands/person/dayMessageChannel.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

vi.mock("../../src/output/json.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/output/json.js")>(),
  writeJson: vi.fn(),
  exitWithError: (error: unknown) => { throw error; },
}));

const client = mockApiClient();
beforeEach(() => vi.resetAllMocks());

test("the setting type is DAY_MESSAGE_CHANNEL (56) and the six values are the global constraint's", () => {
  expect(DAY_MESSAGE_CHANNEL_TYPE_ID).toBe(56);
  expect([...DAY_MESSAGE_CHANNELS]).toEqual(["sms", "whatsapp", "email", "push", "none_self", "none_manual"]);
});

describe("ib person day-message-channel get", () => {
  test("reads personSettings 56 and projects the stringVar", async () => {
    client.get.mockResolvedValueOnce([{ personSettingTypeId: 56, stringVar: "push" }]);
    expect(await runDayMessageChannelGet(client, 9)).toEqual({ personId: 9, value: "push" });
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/person/setting/get/9/56");
  });

  test.each([[[]], [[{ stringVar: "" }]], [[{ stringVar: "fax" }]], [[{ stringVar: null }]]])("no row / blank / unknown value -> null (= SMS) for %j", async (rows) => {
    client.get.mockResolvedValueOnce(rows);
    expect(await runDayMessageChannelGet(client, 9)).toEqual({ personId: 9, value: null });
  });
});

describe("ib person day-message-channel set", () => {
  test("POSTs the person setting the way the profile control does, with write headers", async () => {
    client.get.mockResolvedValueOnce([]);
    client.post.mockResolvedValueOnce(undefined);
    await runDayMessageChannelSet(client, 9, "email", { reason: "driver asked" });
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/person/settings/set", {
      personId: 9, personSettingTypeId: 56, boolVar: false, intVar: 0, stringVar: "email",
    }, { headers: { "X-Action-Reason": "driver asked" } });
  });

  test("clear (value null) stores a blank, which reads back as no preference", async () => {
    client.get.mockResolvedValueOnce([{ stringVar: "none_self" }]);
    client.post.mockResolvedValueOnce(undefined);
    await runDayMessageChannelSet(client, 9, null, {});
    expect(client.post).toHaveBeenCalledWith("/api/person/settings/set", expect.objectContaining({ stringVar: "" }), { headers: {} });
  });

  test("--dry-run resolves client-side: reads, reports the diff, never POSTs", async () => {
    client.get.mockResolvedValueOnce([{ stringVar: "sms" }]);
    expect(await runDayMessageChannelSet(client, 9, "push", { dryRun: true })).toEqual({
      dryRun: true, personId: 9, wouldChange: { value: { from: "sms", to: "push" } },
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  const parse = async (argv: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    const person = program.command("person");
    registerPersonDayMessageChannelCommands(person, async () => client);
    await program.parseAsync(["person", "day-message-channel", ...argv], { from: "user" });
  };

  test.each([
    [["set", "9", "--value", "fax"]],
    [["set", "9", "--value", "SMS"]],
    [["set", "9"]],
    [["set", "9", "--value", "sms", "--clear"]],
    [["set", "--value", "sms"]],
  ])("rejects %j locally (exit 4), nothing sent", async (argv) => {
    await expect(parse(argv)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.post).not.toHaveBeenCalled();
  });

  test("--person is an alias for the positional; --clear unsets", async () => {
    client.get.mockResolvedValue([]);
    await parse(["set", "--person", "9", "--clear"]);
    expect(client.post).toHaveBeenCalledWith("/api/person/settings/set", expect.objectContaining({ personId: 9, stringVar: "" }), { headers: {} });
  });
});

test.each(["ib person day-message-channel get", "ib person day-message-channel set"])("%s has a spec with ERRORS rows", (command) => {
  const spec = COMMAND_SPECS.find((s) => s.command === command);
  expect(spec?.errors?.some((e) => "origin" in e && e.origin === "client" && e.exit === 4)).toBe(true);
  expect(spec?.errors?.some((e) => "http" in e && e.http === 403)).toBe(true);
});
