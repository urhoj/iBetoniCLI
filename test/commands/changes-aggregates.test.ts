import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runChangesLatest,
  runChangesRange,
  runChangesByEntityDate,
  runChangesUser,
} from "../../src/commands/changes/index.js";
import { CliError } from "../../src/api/errors.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const get = () => mockClient.get as ReturnType<typeof vi.fn>;

const ROW = (id: number) => ({
  changeId: id, entityType: "keikka", entityId: 42, changeType: "info_change",
  fieldName: "pumppuAika", oldValue: "08:00", newValue: "09:00", personId: 8,
  personFullName: "Juha Urho", timestamp: "2026-06-10T10:00:00.000Z",
  description: "Aika siirretty",
});

describe("changes aggregates", () => {
  beforeEach(() => get().mockReset());

  test("latest: GET /api/changes/latest/<owner> with limit + entityType", async () => {
    get().mockResolvedValueOnce([ROW(1)]);
    const result = await runChangesLatest(mockClient, 50, { entityType: "keikka", owner: 27 });
    expect(get()).toHaveBeenCalledWith("/api/changes/latest/27?limit=50&entityType=keikka");
    expect(result.count).toBe(1);
    expect(result.items[0].field).toBe("pumppuAika");
  });

  test("range: GET /api/changes/range/<owner> with startDate/endDate/personId", async () => {
    get().mockResolvedValueOnce([ROW(1), ROW(2)]);
    const result = await runChangesRange(mockClient, {
      from: "2026-06-01",
      to: "2026-06-10",
      person: 8,
      owner: 27,
      limit: 200,
    });
    expect(get()).toHaveBeenCalledWith(
      "/api/changes/range/27?startDate=2026-06-01&endDate=2026-06-10&personId=8"
    );
    expect(result.count).toBe(2);
    expect(result.truncated).toBeUndefined();
  });

  test("range: client-side --limit slices and sets truncated", async () => {
    get().mockResolvedValueOnce([ROW(1), ROW(2), ROW(3)]);
    const result = await runChangesRange(mockClient, {
      from: "2026-06-01", to: "2026-06-10", owner: 27, limit: 2,
    });
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("range: bad --from is CliError exit 4, no fetch", async () => {
    let err: unknown;
    try {
      await runChangesRange(mockClient, { from: "soon", to: "2026-06-10", owner: 27, limit: 200 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect(get()).not.toHaveBeenCalled();
  });

  test("by-entity-date: requires keikka|palkki", async () => {
    let err: unknown;
    try {
      await runChangesByEntityDate(mockClient, {
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
    const result = await runChangesByEntityDate(mockClient, {
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
    const self = await runChangesUser(mockClient, null, 100, { owner: 27 });
    expect(get()).toHaveBeenCalledWith("/api/changes/user/recent/27?limit=100");
    expect(self.items[0].entityDisplayName).toBe("42 - Tilaus");

    get().mockReset();
    get().mockResolvedValueOnce([]);
    await runChangesUser(mockClient, 63, 50, { owner: 27 });
    expect(get()).toHaveBeenCalledWith("/api/changes/user/63/27?limit=50");
  });

  test("owner resolution used when --owner absent", async () => {
    get()
      .mockResolvedValueOnce({ currentCompanyId: 27 })
      .mockResolvedValueOnce([]);
    await runChangesLatest(mockClient, 100, {});
    expect(get()).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
  });
});
