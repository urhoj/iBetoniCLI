import { Command } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  DRIVER_DAY_PUSH_TYPE_ID,
  registerPersonDriverDayPushCommands,
  runDriverDayPushGet,
  runDriverDayPushSet,
} from "../../src/commands/person/driverDayPush.js";
import { runBetomikDayPushPreview } from "../../src/commands/betomikOrderbook/index.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

vi.mock("../../src/output/json.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/output/json.js")>(),
  writeJson: vi.fn(),
  exitWithError: (error: unknown) => { throw error; },
}));

const client = mockApiClient();
beforeEach(() => vi.resetAllMocks());

test("the setting type is NOTIFY_DAILY_CONFIRMED (34)", () => {
  expect(DRIVER_DAY_PUSH_TYPE_ID).toBe(34);
});

describe("ib person driver-day-push get", () => {
  test("reads personSettings 34 and projects the boolVar", async () => {
    client.get.mockResolvedValueOnce([{ personSettingTypeId: 34, boolVar: true }]);
    expect(await runDriverDayPushGet(client, 9)).toEqual({ personId: 9, enabled: true });
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/person/setting/get/9/34");
  });

  test.each([[[]], [[{ boolVar: false }]], [[{ boolVar: null }]]])("no row / off -> enabled:false for %j", async (rows) => {
    client.get.mockResolvedValueOnce(rows);
    expect(await runDriverDayPushGet(client, 9)).toEqual({ personId: 9, enabled: false });
  });
});

describe("ib person driver-day-push set", () => {
  test("POSTs the person setting the way the profile switch does, with write headers", async () => {
    client.post.mockResolvedValueOnce(undefined);
    await runDriverDayPushSet(client, 9, true, { reason: "driver asked" });
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/person/settings/set", {
      personId: 9, personSettingTypeId: 34, boolVar: true, intVar: 0, stringVar: "",
    }, { headers: { "X-Action-Reason": "driver asked" } });
  });

  test("--dry-run resolves client-side: reads, reports the diff, never POSTs", async () => {
    client.get.mockResolvedValueOnce([{ boolVar: true }]);
    expect(await runDriverDayPushSet(client, 9, false, { dryRun: true })).toEqual({
      dryRun: true, personId: 9, wouldChange: { enabled: { from: true, to: false } },
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  const parse = async (argv: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    const person = program.command("person");
    registerPersonDriverDayPushCommands(person, async () => client);
    await program.parseAsync(["person", "driver-day-push", ...argv], { from: "user" });
  };

  test.each([[["set", "9"]], [["set", "9", "--on", "--off"]], [["set", "--on"]]])("rejects %j locally (exit 4), nothing sent", async (argv) => {
    await expect(parse(argv)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.post).not.toHaveBeenCalled();
  });

  test("--person is an alias for the positional; --off stores false", async () => {
    await parse(["set", "--person", "9", "--off"]);
    expect(client.post).toHaveBeenCalledWith("/api/person/settings/set", expect.objectContaining({ personId: 9, boolVar: false }), { headers: {} });
  });
});

test("ib dev betomik-orderbook day-push-preview GETs the preview route", async () => {
  client.get.mockResolvedValueOnce({ pvm: 20261029, optedIn: 3, sent: 2, already: 0, empty: 1, noDevice: 0, failed: 0 });
  expect(await runBetomikDayPushPreview(client)).toMatchObject({ optedIn: 3, sent: 2 });
  expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/betomik-orderbook/day-push/preview");
});

test.each(["ib person driver-day-push get", "ib person driver-day-push set"])("%s has a spec with ERRORS rows", (command) => {
  const spec = COMMAND_SPECS.find((s) => s.command === command);
  expect(spec?.errors?.some((e) => "origin" in e && e.origin === "client" && e.exit === 4)).toBe(true);
  expect(spec?.errors?.some((e) => "http" in e && e.http === 403)).toBe(true);
});
