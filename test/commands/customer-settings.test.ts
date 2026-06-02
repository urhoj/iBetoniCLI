import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  parseSettingChanges,
  runCustomerSettingsApply,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const get = () => mockClient.get as ReturnType<typeof vi.fn>;
const post = () => mockClient.post as ReturnType<typeof vi.fn>;

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
});
