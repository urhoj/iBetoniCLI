import { describe, test, expect } from "vitest";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import { runVehicleFkGet, runVehicleFkList, runVehicleFkRemove, runVehicleFkSet } from "../../src/commands/vehicle/fk.js";

const SOURCES = [
  { foreignKeySourceId: 5, foreignKeySourceName: "ecofleet", foreignKeySourceColumn: "objectId", ownerAsiakasId: 27 },
  { foreignKeySourceId: 6, foreignKeySourceName: "mapon", foreignKeySourceColumn: "unit_id", ownerAsiakasId: 27 },
];

/** keysBySource: what GET /foreignKeys/get/:vehicleId/:sourceId answers per source. */
function client(keysBySource: Record<number, string | undefined>): MockApiClient {
  const c = mockApiClient();
  c.get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/foreignKey/sourceList/")) return SOURCES;
    const sourceId = Number(path.split("/").pop());
    const key = keysBySource[sourceId];
    return key === undefined ? [] : [{ foreignKey: key }];
  });
  c.post.mockResolvedValue({ success: true, rowsAffected: 1 });
  return c;
}

describe("vehicle fk", () => {
  test("get resolves the source and returns the key (null when absent)", async () => {
    const c = client({ 5: "ECO-1" });
    expect(await runVehicleFkGet(c, 135, { source: "ecofleet", owner: 27 })).toEqual({ vehicleId: 135, source: "ecofleet", sourceId: 5, key: "ECO-1" });
    expect(c.get).toHaveBeenCalledWith("/api/vehicle/foreignKeys/get/135/5");
    expect((await runVehicleFkGet(c, 135, { source: "mapon", owner: 27 })).key).toBeNull();
  });

  test("list fans out over the owner's sources and drops empty ones", async () => {
    const c = client({ 6: "MAP-9" });
    const out = await runVehicleFkList(c, 135, 27);
    expect(out).toEqual({ items: [{ vehicleId: 135, key: "MAP-9", source: "mapon", sourceId: 6 }], nextCursor: null, count: 1, truncated: false });
  });

  test("set posts with write headers, names the action, and skips an unchanged key", async () => {
    const c = client({});
    const out = await runVehicleFkSet(c, 135, { source: "mapon", key: "MAP-9", owner: 27 }, { reason: "gps" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/foreignKeys/set",
      { vehicleId: 135, foreignKeySourceId: 6, foreignKey: "MAP-9" },
      { headers: { "X-Action-Reason": "gps" } }
    );
    expect(out).toEqual({ vehicleId: 135, source: "mapon", sourceId: 6, key: "MAP-9", action: "inserted" });

    const c2 = client({ 6: "MAP-9" });
    expect(await runVehicleFkSet(c2, 135, { source: "6", key: "MAP-9", owner: 27 }, {})).toMatchObject({ action: "unchanged" });
    expect(c2.post).not.toHaveBeenCalled();
    expect(await runVehicleFkSet(c2, 135, { source: "6", key: "MAP-10", owner: 27 }, {})).toMatchObject({ action: "updated" });
  });

  test("set --dry-run goes to the server (X-Dry-Run) and returns its echo", async () => {
    const c = client({});
    c.post.mockResolvedValue({ dryRun: true, wouldUpdate: { vehicleId: 135, foreignKeySourceId: 6, foreignKey: "x" }, ok: true });
    const out = await runVehicleFkSet(c, 135, { source: "mapon", key: "x", owner: 27 }, { dryRun: true });
    expect(c.post).toHaveBeenCalledWith("/api/vehicle/foreignKeys/set", expect.anything(), { headers: { "X-Dry-Run": "1" } });
    expect(out).toMatchObject({ dryRun: true, would: { action: "inserted", key: "x" } });
  });

  test("remove sends the empty-key form the backend treats as delete; nothing there → unchanged, no POST", async () => {
    const c = client({ 5: "ECO-1" });
    const out = await runVehicleFkRemove(c, 135, { source: "ecofleet", owner: 27 }, { reason: "sold" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/foreignKeys/set",
      { vehicleId: 135, foreignKeySourceId: 5, foreignKey: "" },
      { headers: { "X-Action-Reason": "sold" } }
    );
    expect(out).toEqual({ vehicleId: 135, source: "ecofleet", sourceId: 5, key: "ECO-1", action: "removed" });
    expect(await runVehicleFkRemove(c, 135, { source: "mapon", owner: 27 }, {})).toMatchObject({ action: "unchanged" });
    expect(c.post).toHaveBeenCalledTimes(1);
  });
});
