import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  parseGpsProvider,
  parseSettingChanges,
  runCustomerSettingsApply,
} from "../../src/commands/customer/index.js";

const mockClient = mockApiClient();
const get = () => mockClient.get;
const post = () => mockClient.post;

const SETTINGS_STATE = {
  asiakasId: 26,
  roolit: { isTyomaaAsiakas: true, isPumppuToimittaja: false, isBetoniToimittaja: true, isLattiaToimittaja: false },
  settings: { HAS_FENNOA: false, ALV: false, HAS_JERRY: false },
};

describe("parseSettingChanges", () => {
  test("accepts canonical names case-insensitively", () => {
    const ch = parseSettingChanges("has_fennoa,ALV", "HAS_OCR");
    expect(ch.get("has_fennoa")).toBe(true);
    expect(ch.get("alv")).toBe(true);
    expect(ch.get("has_ocr")).toBe(false);
  });

  test("accepts the 8 friendly aliases and pumppu", () => {
    const ch = parseSettingChanges("jerry,pumppu", undefined);
    expect(ch.get("jerry")).toBe(true);
    expect(ch.get("pumppu")).toBe(true);
  });

  test("rejects an unknown name", () => {
    expect(() => parseSettingChanges("not_a_setting", undefined)).toThrow(/unknown field/);
  });

  test("rejects a key given to both --set and --unset", () => {
    expect(() => parseSettingChanges("has_fennoa", "has_fennoa")).toThrow(/both --set and --unset/);
  });
});

describe("runCustomerSettingsApply", () => {
  beforeEach(() => {
    get().mockReset();
    post().mockReset();
    post().mockResolvedValue({ ok: true });
  });

  test("canonical name batches into settings/save with the right typeId", async () => {
    get().mockResolvedValue(SETTINGS_STATE);
    await runCustomerSettingsApply(mockClient, 26, new Map([["has_fennoa", true]]), {});
    expect(post()).toHaveBeenCalledWith(
      "/api/asiakas/settings/save",
      [
        {
          asiakasSettingId: null,
          asiakasId: 26,
          laskuttajaAsiakasId: 26,
          asiakasSettingTypeId: 17,
          asiakasSettingBool: true,
        },
      ],
      { headers: {} }
    );
  });

  test("re-fetches the full settings report as state", async () => {
    get().mockResolvedValue(SETTINGS_STATE);
    const result = await runCustomerSettingsApply(mockClient, 26, new Map([["alv", true]]), {});
    expect(result.state).toEqual(SETTINGS_STATE);
    expect(result.applied.set).toEqual(["alv"]);
  });

  // The provider token rides on the HAS_ECOFLEET row (typeId 15) as
  // asiakasSettingString. Rows carry only the columns being changed — the
  // backend read-merges the rest (fb#1765) — so a provider-only write must NOT
  // send asiakasSettingBool (it would toggle GPS), and a combined write must be
  // ONE row, not two upserts racing on the same key.
  test("--gps-provider alone writes only the string column of the HAS_ECOFLEET row", async () => {
    get().mockResolvedValue({ ...SETTINGS_STATE, gpsProvider: "mapon" });
    const result = await runCustomerSettingsApply(mockClient, 27, new Map(), {}, "mapon");
    expect(post()).toHaveBeenCalledWith(
      "/api/asiakas/settings/save",
      [{ asiakasSettingId: null, asiakasId: 27, laskuttajaAsiakasId: 27, asiakasSettingTypeId: 15, asiakasSettingString: "mapon" }],
      { headers: {} }
    );
    expect(result.applied).toEqual({ set: [], unset: [], dryRun: false, gpsProvider: "mapon" });
    expect(result.state.gpsProvider).toBe("mapon");
  });

  test("--set HAS_ECOFLEET --gps-provider mapon folds into one row", async () => {
    get().mockResolvedValue(SETTINGS_STATE);
    await runCustomerSettingsApply(mockClient, 27, new Map([["has_ecofleet", true]]), {}, "mapon");
    const rows = post().mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ asiakasSettingTypeId: 15, asiakasSettingBool: true, asiakasSettingString: "mapon" });
  });

  test("bool-only toggle still sends no string column (backend preserves it)", async () => {
    get().mockResolvedValue(SETTINGS_STATE);
    await runCustomerSettingsApply(mockClient, 27, new Map([["has_ecofleet", false]]), {});
    expect(post().mock.calls[0][1][0]).not.toHaveProperty("asiakasSettingString");
  });
});

describe("parseGpsProvider", () => {
  test("accepts the two tokens case-insensitively, undefined passes through", () => {
    expect(parseGpsProvider("Mapon")).toBe("mapon");
    expect(parseGpsProvider("ecofleet")).toBe("ecofleet");
    expect(parseGpsProvider(undefined)).toBeUndefined();
  });

  test("rejects anything else", () => {
    expect(() => parseGpsProvider("garmin")).toThrow(/unknown --gps-provider: garmin/);
  });
});
