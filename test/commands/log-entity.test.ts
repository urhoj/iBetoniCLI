import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runLogEntity } from "../../src/commands/log/index.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = mockApiClient();
const get = () => mockClient.get;

const ROW = {
  changeId: 1, entityType: "keikka", entityId: 42, changeType: "info_change",
  fieldName: "laskuMemo", oldValue: "a", newValue: "b", personId: 8,
  personFullName: "Juha Urho", timestamp: "2026-06-10T10:00:00.000Z",
  description: "Laskun muistiinpanot muutettu", reason: "fix typo",
  impersonatedByPersonName: null, keikkaTilaContext: 3, deviceType: "desktop",
};

describe("runLogEntity", () => {
  beforeEach(() => get().mockReset());

  test("resolves owner, GETs /api/changes/<type>/<id>/<owner>, projects rows", async () => {
    get()
      .mockResolvedValueOnce({ currentCompanyId: 27 })
      .mockResolvedValueOnce([ROW]);
    const result = await runLogEntity(mockClient, "keikka", 42, 100, {});
    expect(get()).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
    expect(get()).toHaveBeenNthCalledWith(2, "/api/changes/keikka/42/27?limit=100");
    expect(result.count).toBe(1);
    expect(result.items[0]).toMatchObject({
      changeId: 1,
      entityType: "keikka",
      entityId: 42,
      field: "laskuMemo",
      personName: "Juha Urho",
      at: "2026-06-10T10:00:00.000Z",
      reason: "fix typo",
      keikkaTilaContext: 3,
      deviceType: "desktop",
    });
  });

  test("--owner skips company-selection; --field filters client-side", async () => {
    get().mockResolvedValueOnce([ROW, { ...ROW, changeId: 2, fieldName: "kuskit" }]);
    const result = await runLogEntity(mockClient, "keikka", 42, 100, {
      owner: 27,
      field: "kuskit",
    });
    expect(get()).toHaveBeenCalledTimes(1);
    expect(get()).toHaveBeenCalledWith("/api/changes/keikka/42/27?limit=100");
    expect(result.count).toBe(1);
    expect(result.items[0].field).toBe("kuskit");
  });

  test("missing proc columns (pre-migration aggregate rows) project as null", async () => {
    get().mockResolvedValueOnce([{ changeId: 3, fieldName: "x", timestamp: "t" }]);
    const result = await runLogEntity(mockClient, "vehicle", 5, 50, { owner: 27 });
    expect(result.items[0].reason).toBeNull();
    expect(result.items[0].impersonatedByPersonName).toBeNull();
  });

  test("unknown entityType throws CliError exit 4 listing valid types", async () => {
    let err: unknown;
    try {
      await runLogEntity(mockClient, "banana", 1, 100, { owner: 27 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect((err as CliError).message).toMatch(/keikka/);
    expect(get()).not.toHaveBeenCalled();
  });

  test("kuski is accepted (deprecated, but historical rows exist)", async () => {
    get().mockResolvedValueOnce([]);
    const result = await runLogEntity(mockClient, "kuski", 42, 100, { owner: 27 });
    expect(result.count).toBe(0);
  });

  describe("server-capped page signalling", () => {
    const rows = (n: number, field = "laskuMemo") =>
      Array.from({ length: n }, (_, i) => ({ ...ROW, changeId: i + 1, fieldName: field }));

    test("a full page sets truncated (more history may exist)", async () => {
      get().mockResolvedValueOnce(rows(5));
      const result = await runLogEntity(mockClient, "keikka", 42, 5, { owner: 27 });
      expect(result.count).toBe(5);
      expect(result.truncated).toBe(true);
    });

    test("a partial page omits truncated", async () => {
      get().mockResolvedValueOnce(rows(3));
      const result = await runLogEntity(mockClient, "keikka", 42, 5, { owner: 27 });
      expect(result.truncated).toBeUndefined();
      expect(result.hint).toBeUndefined();
    });

    test("--field on a capped page warns the filter only saw that window", async () => {
      // 5 rows fill the limit; none match the requested field, so the result is
      // empty — which without the hint reads as "this field never changed".
      get().mockResolvedValueOnce(rows(5, "otherField"));
      const result = await runLogEntity(mockClient, "keikka", 42, 5, {
        owner: 27,
        field: "laskuMemo",
      });
      expect(result.count).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.hint).toMatch(/newest 5 changes only/);
    });

    test("--field on a partial page needs no hint (the whole history was seen)", async () => {
      get().mockResolvedValueOnce([...rows(2, "otherField"), ROW]);
      const result = await runLogEntity(mockClient, "keikka", 42, 100, {
        owner: 27,
        field: "laskuMemo",
      });
      expect(result.count).toBe(1);
      expect(result.hint).toBeUndefined();
    });
  });
});
