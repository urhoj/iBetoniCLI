import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runPersonDayStatuses,
  runPersonDayGet,
  resolveStatusId,
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
