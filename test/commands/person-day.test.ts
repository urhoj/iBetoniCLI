import { describe, test, expect, vi } from "vitest";
import {
  runPersonDayStatuses,
  runPersonDayGet,
  resolveStatusId,
  runPersonDaySet,
  runPersonDayClear,
} from "../../src/commands/person/day.js";
import type { ApiClient } from "../../src/api/client.js";

const JWT =
  "e30." +
  Buffer.from(JSON.stringify({ ownerAsiakasId: 1349, personId: 1 })).toString("base64url") +
  ".sig";

function makeClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn().mockReturnValue(JWT),
  } as unknown as ApiClient;
}

describe("runPersonDayStatuses", () => {
  test("projects statusList rows", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmStatusId: 2, personPvmStatus: "L", personPvmStatusName: "Loma", pois: true, vakioVapaa: false },
      { personPvmStatusId: 5, personPvmStatus: "T", personPvmStatusName: "Töissä", pois: false, vakioVapaa: false },
    ]);
    const out = await runPersonDayStatuses(c);
    expect(c.get).toHaveBeenCalledWith("/api/personPvm/statusList/1349");
    expect(out).toEqual({
      items: [
        { statusId: 2, code: "L", name: "Loma", pois: true, vakioVapaa: false },
        { statusId: 5, code: "T", name: "Töissä", pois: false, vakioVapaa: false },
      ],
      nextCursor: null,
      count: 2,
    });
  });
});

describe("runPersonDayGet", () => {
  test("encodes range + personId and projects rows", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 2, personPvmText: "ranta", pois: true, personPvmStatus: "L", personPvmStatusName: "Loma" },
    ]);
    const out = await runPersonDayGet(c, 555, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith(
      "/api/personPvm/list/1349?startDate=2026-06-10&endDate=2026-06-10&personId=555"
    );
    expect(out.items[0]).toEqual({
      personPvmId: 91, date: "2026-06-10", statusId: 2, status: "L", statusName: "Loma", pois: true, vehicleId: null, text: "ranta",
    });
    expect(out.count).toBe(1);
  });
});

describe("resolveStatusId", () => {
  test("numeric value passes through without a lookup", async () => {
    const c = makeClient();
    const id = await resolveStatusId(c, "7");
    expect(id).toBe(7);
    expect(c.get).not.toHaveBeenCalled();
  });
  test("resolves a name case-insensitively via statusList", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmStatusId: 2, personPvmStatus: "L", personPvmStatusName: "Loma", pois: true, vakioVapaa: false },
    ]);
    const id = await resolveStatusId(c, "loma");
    expect(id).toBe(2);
  });
  test("unknown name exits 4", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmStatusId: 2, personPvmStatus: "L", personPvmStatusName: "Loma", pois: true, vakioVapaa: false },
    ]);
    await expect(resolveStatusId(c, "nope")).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("runPersonDaySet", () => {
  test("dry-run reads current row, computes wouldChange, never POSTs", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 5, personPvmText: null, pois: false, personPvmStatus: "T", personPvmStatusName: "Töissä" },
    ]);
    const out = await runPersonDaySet(c, 555, "2026-06-10", "2", { dryRun: true, reason: "vacation", text: "ranta" });
    expect(c.post).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      personId: 555,
      date: "2026-06-10",
      wouldChange: { status: { from: 5, to: 2 }, text: { from: null, to: "ranta" } },
    });
  });

  test("real write: existing row → POST includes personPvmId (update, not insert)", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 5, personPvmText: null, pois: false, personPvmStatus: "T", personPvmStatusName: "Töissä" },
    ]);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ personPvmId: 91 });
    await runPersonDaySet(c, 555, "2026-06-10", "2", { reason: "vacation" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/save/1349",
      { personId: 555, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, vehicleId: null, personPvmId: 91 },
      { headers: { "X-Action-Reason": "vacation" } }
    );
  });

  test("real write: no existing row → POST omits personPvmId (insert)", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ personPvmId: 200 });
    await runPersonDaySet(c, 555, "2026-06-10", "2", { reason: "vacation" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/save/1349",
      { personId: 555, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, vehicleId: null },
      { headers: { "X-Action-Reason": "vacation" } }
    );
  });

  test("real write: preserves the existing vehicleId (does not wipe day driver)", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: 53, pvm: 20260610, personPvmStatusId: 5, personPvmText: null, pois: false, personPvmStatus: "T", personPvmStatusName: "Töissä" },
    ]);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ personPvmId: 91 });
    await runPersonDaySet(c, 555, "2026-06-10", "2", { reason: "vacation" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/save/1349",
      { personId: 555, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, vehicleId: 53, personPvmId: 91 },
      { headers: { "X-Action-Reason": "vacation" } }
    );
  });
});

describe("runPersonDayClear", () => {
  test("dry-run resolves the row, returns wouldDelete, never DELETEs", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, pois: true, personPvmStatus: "L", personPvmStatusName: "Loma" },
    ]);
    const out = await runPersonDayClear(c, 555, "2026-06-10", { dryRun: true, reason: "x" });
    expect(c.delete).not.toHaveBeenCalled();
    expect(out).toEqual({ dryRun: true, wouldDelete: { personPvmId: 91, date: "2026-06-10", status: "Loma" } });
  });

  test("real: existing row → DELETE the resolved id", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, pois: true, personPvmStatus: "L", personPvmStatusName: "Loma" },
    ]);
    (c.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 1 });
    await runPersonDayClear(c, 555, "2026-06-10", { reason: "back to work" });
    expect(c.delete).toHaveBeenCalledWith("/api/personPvm/delete/1349/91", {
      headers: { "X-Action-Reason": "back to work" },
    });
  });

  test("real: no row → no DELETE, returns deleted:false", async () => {
    const c = makeClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const out = await runPersonDayClear(c, 555, "2026-06-10", { reason: "x" });
    expect(c.delete).not.toHaveBeenCalled();
    expect(out).toEqual({ deleted: false, message: "no personPvm row for that person/date" });
  });
});
