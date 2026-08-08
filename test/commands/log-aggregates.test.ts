import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runLogLatest,
  runLogRange,
  runLogByEntityDate,
  runLogUser,
} from "../../src/commands/log/index.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = mockApiClient();
const get = () => mockClient.get;

const ROW = (id: number) => ({
  changeId: id, entityType: "keikka", entityId: 42, changeType: "info_change",
  fieldName: "pumppuAika", oldValue: "08:00", newValue: "09:00", personId: 8,
  personFullName: "Juha Urho", timestamp: "2026-06-10T10:00:00.000Z",
  description: "Aika siirretty",
});

describe("log aggregates", () => {
  beforeEach(() => get().mockReset());

  test("latest: GET /api/changes/latest/<owner> with limit + entityType", async () => {
    get().mockResolvedValueOnce([ROW(1)]);
    const result = await runLogLatest(mockClient, 50, { entityType: "keikka", owner: 27 });
    expect(get()).toHaveBeenCalledWith("/api/changes/latest/27?limit=50&entityType=keikka");
    expect(result.count).toBe(1);
    expect(result.items[0].field).toBe("pumppuAika");
  });

  test("range: GET /api/changes/range/<owner> with startDate/endDate/entityType/personId", async () => {
    get().mockResolvedValueOnce([ROW(1), ROW(2)]);
    const result = await runLogRange(mockClient, {
      from: "2026-06-01",
      to: "2026-06-10",
      entityType: "keikka",
      person: 8,
      owner: 27,
      limit: 200,
    });
    expect(get()).toHaveBeenCalledWith(
      "/api/changes/range/27?startDate=2026-06-01&endDate=2026-06-10&entityType=keikka&personId=8"
    );
    expect(result.count).toBe(2);
    expect(result.truncated).toBeUndefined();
  });

  test("range: client-side --limit slices and sets truncated", async () => {
    get().mockResolvedValueOnce([ROW(1), ROW(2), ROW(3)]);
    const result = await runLogRange(mockClient, {
      from: "2026-06-01", to: "2026-06-10", owner: 27, limit: 2,
    });
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("range: bad --from is CliError exit 4, no fetch", async () => {
    let err: unknown;
    try {
      await runLogRange(mockClient, { from: "soon", to: "2026-06-10", owner: 27, limit: 200 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect(get()).not.toHaveBeenCalled();
  });

  test("latest: unknown entityType is CliError exit 4, no fetch", async () => {
    let err: unknown;
    try {
      await runLogLatest(mockClient, 50, { entityType: "banana", owner: 27 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect(get()).not.toHaveBeenCalled();
  });

  test("by-entity-date: client-side --limit slices and sets truncated", async () => {
    get().mockResolvedValueOnce([ROW(1), ROW(2), ROW(3)]);
    const result = await runLogByEntityDate(mockClient, {
      entityType: "keikka", from: "2026-06-01", to: "2026-06-10", owner: 27, limit: 2,
    });
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("by-entity-date: requires keikka|palkki", async () => {
    let err: unknown;
    try {
      await runLogByEntityDate(mockClient, {
        entityType: "vehicle", from: "2026-06-01", to: "2026-06-10", owner: 27, limit: 200,
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
  });

  test("by-entity-date: GET with entityType + window; projects palkki context", async () => {
    get().mockResolvedValueOnce([
      { ...ROW(1), entityType: "palkki", palkkiText: "Pumppu 1", palkkiVehicleRegNo: "ABC-123" },
    ]);
    const result = await runLogByEntityDate(mockClient, {
      entityType: "palkki", from: "2026-06-10", to: "2026-06-10", owner: 27, limit: 200,
    });
    expect(get()).toHaveBeenCalledWith(
      "/api/changes/by-entity-date/27?startDate=2026-06-10&endDate=2026-06-10&entityType=palkki"
    );
    expect(result.items[0].palkkiText).toBe("Pumppu 1");
    expect(result.items[0].palkkiVehicleRegNo).toBe("ABC-123");
  });

  test("user without personId hits /user/recent; with personId hits /user/<id>", async () => {
    get().mockResolvedValueOnce([{ ...ROW(1), entityDisplayName: "42 - Tilaus" }]);
    const self = await runLogUser(mockClient, null, 100, { owner: 27 });
    expect(get()).toHaveBeenCalledWith("/api/changes/user/recent/27?limit=100");
    expect(self.items[0].entityDisplayName).toBe("42 - Tilaus");

    get().mockReset();
    get().mockResolvedValueOnce([]);
    await runLogUser(mockClient, 63, 50, { owner: 27 });
    expect(get()).toHaveBeenCalledWith("/api/changes/user/63/27?limit=50");
  });

  test("owner resolution used when --owner absent", async () => {
    get()
      .mockResolvedValueOnce({ currentCompanyId: 27 })
      .mockResolvedValueOnce([]);
    await runLogLatest(mockClient, 100, {});
    expect(get()).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
    expect(get()).toHaveBeenNthCalledWith(2, "/api/changes/latest/27?limit=100");
  });

  describe("server-capped page signalling", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ROW(i + 1));

    test("latest: a full page sets truncated", async () => {
      get().mockResolvedValueOnce(rows(4));
      const result = await runLogLatest(mockClient, 4, { owner: 27 });
      expect(result.truncated).toBe(true);
    });

    test("latest: a partial page omits truncated", async () => {
      get().mockResolvedValueOnce(rows(2));
      expect((await runLogLatest(mockClient, 4, { owner: 27 })).truncated).toBeUndefined();
    });

    test("user: a full page sets truncated", async () => {
      get().mockResolvedValueOnce(rows(4));
      const result = await runLogUser(mockClient, 63, 4, { owner: 27 });
      expect(result.truncated).toBe(true);
    });

    test("user: a partial page omits truncated", async () => {
      get().mockResolvedValueOnce(rows(1));
      expect((await runLogUser(mockClient, 63, 4, { owner: 27 })).truncated).toBeUndefined();
    });
  });
});
