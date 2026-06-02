import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  parseModuleChanges,
  runCustomerModulesApply,
  operatorPresetChanges,
  runCustomerOperatorVerify,
  ALL_FIELD_KEYS,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const get = () => mockClient.get as ReturnType<typeof vi.fn>;
const post = () => mockClient.post as ReturnType<typeof vi.fn>;

/** A baseline report with everything off, used for the roolit-read + re-fetch. */
const STATE_OFF = {
  asiakasId: 26,
  roolit: {
    isTyomaaAsiakas: true,
    isPumppuToimittaja: false,
    isBetoniToimittaja: true,
    isLattiaToimittaja: false,
  },
  modules: {
    jerry: false,
    henkilot: false,
    sijainnit: false,
    ajoneuvot: false,
    tiedostot: false,
    weather: false,
    lomaseuranta: false,
    shareorders: false,
  },
};

describe("parseModuleChanges", () => {
  test("maps --set to true and --unset to false", () => {
    const changes = parseModuleChanges("jerry,weather", "shareorders");
    expect(changes.get("jerry")).toBe(true);
    expect(changes.get("weather")).toBe(true);
    expect(changes.get("shareorders")).toBe(false);
    expect(changes.size).toBe(3);
  });

  test("normalizes case and whitespace", () => {
    const changes = parseModuleChanges("  Jerry , PUMPPU ", undefined);
    expect(changes.get("jerry")).toBe(true);
    expect(changes.get("pumppu")).toBe(true);
  });

  test("rejects an unknown field", () => {
    expect(() => parseModuleChanges("nope", undefined)).toThrow(/unknown field: nope/);
  });

  test("rejects a key requested both ON and OFF", () => {
    expect(() => parseModuleChanges("jerry", "jerry")).toThrow(/both --set and --unset/);
  });

  test("rejects empty input", () => {
    expect(() => parseModuleChanges(undefined, undefined)).toThrow(/no fields given/);
  });

  test("ALL_FIELD_KEYS includes pumppu plus the 8 modules", () => {
    expect(ALL_FIELD_KEYS).toContain("pumppu");
    expect(ALL_FIELD_KEYS.length).toBe(9);
  });
});

describe("runCustomerModulesApply", () => {
  beforeEach(() => {
    get().mockReset();
    post().mockReset();
    post().mockResolvedValue({ ok: true });
  });

  test("pumppu routes to setRoolit, echoing the other three roolit booleans", async () => {
    get().mockResolvedValue(STATE_OFF); // roolit read + final re-fetch
    await runCustomerModulesApply(
      mockClient,
      26,
      new Map([["pumppu", true]]),
      { reason: "enable operator" }
    );
    expect(post()).toHaveBeenCalledWith(
      "/api/asiakas/setRoolit",
      {
        asiakasId: 26,
        isTyomaaAsiakas: true,
        isPumppuToimittaja: true,
        isBetoniToimittaja: true,
        isLattiaToimittaja: false,
      },
      { headers: { "X-Action-Reason": "enable operator" } }
    );
    // No settings/save call when only pumppu changes.
    expect(post()).toHaveBeenCalledTimes(1);
  });

  test("module keys batch into one settings/save with self laskuttaja + upsert id", async () => {
    get().mockResolvedValue(STATE_OFF);
    await runCustomerModulesApply(
      mockClient,
      26,
      new Map([
        ["jerry", true],
        ["shareorders", false],
      ]),
      { dryRun: true }
    );
    expect(post()).toHaveBeenCalledWith(
      "/api/asiakas/settings/save",
      [
        {
          asiakasSettingId: null,
          asiakasId: 26,
          laskuttajaAsiakasId: 26,
          asiakasSettingTypeId: 35, // HAS_JERRY
          asiakasSettingBool: true,
        },
        {
          asiakasSettingId: null,
          asiakasId: 26,
          laskuttajaAsiakasId: 26,
          asiakasSettingTypeId: 33, // SHARE_ORDERS_WITH_BETONI
          asiakasSettingBool: false,
        },
      ],
      { headers: { "X-Dry-Run": "1" } }
    );
    // No setRoolit call when pumppu is not among the changes.
    expect(post()).toHaveBeenCalledTimes(1);
  });

  test("pumppu + modules issue both writes and report applied/state", async () => {
    get().mockResolvedValue(STATE_OFF);
    const result = await runCustomerModulesApply(
      mockClient,
      26,
      new Map([
        ["pumppu", true],
        ["jerry", true],
      ]),
      {}
    );
    const paths = post().mock.calls.map((c) => c[0]);
    expect(paths).toContain("/api/asiakas/setRoolit");
    expect(paths).toContain("/api/asiakas/settings/save");
    expect(result.applied.set.sort()).toEqual(["jerry", "pumppu"]);
    expect(result.applied.unset).toEqual([]);
    expect(result.applied.dryRun).toBe(false);
    expect(result.state).toEqual(STATE_OFF);
  });
});

describe("operatorPresetChanges", () => {
  test("--set preset sets all 9 fields true", () => {
    const changes = operatorPresetChanges(true);
    expect(changes.size).toBe(9);
    expect([...changes.values()].every((v) => v === true)).toBe(true);
    expect(changes.get("pumppu")).toBe(true);
  });

  test("--reset preset sets all 9 fields false", () => {
    const changes = operatorPresetChanges(false);
    expect(changes.size).toBe(9);
    expect([...changes.values()].every((v) => v === false)).toBe(true);
  });
});

describe("runCustomerOperatorVerify", () => {
  beforeEach(() => {
    get().mockReset();
  });

  test("allSet=false and lists missing when some flags are off", async () => {
    get().mockResolvedValueOnce(STATE_OFF);
    const result = await runCustomerOperatorVerify(mockClient, 26);
    expect(result.allSet).toBe(false);
    expect(result.flags.pumppu).toBe(false);
    expect(result.missing.sort()).toEqual([...ALL_FIELD_KEYS].sort());
  });

  test("allSet=true with no missing when every flag is on", async () => {
    const allOn = {
      asiakasId: 26,
      roolit: {
        isTyomaaAsiakas: false,
        isPumppuToimittaja: true,
        isBetoniToimittaja: false,
        isLattiaToimittaja: false,
      },
      modules: {
        jerry: true,
        henkilot: true,
        sijainnit: true,
        ajoneuvot: true,
        tiedostot: true,
        weather: true,
        lomaseuranta: true,
        shareorders: true,
      },
    };
    get().mockResolvedValueOnce(allOn);
    const result = await runCustomerOperatorVerify(mockClient, 26);
    expect(result.allSet).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
