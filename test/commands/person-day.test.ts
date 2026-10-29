import { describe, test, expect, vi } from "vitest";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import {
  runPersonDayStatuses,
  runPersonDayGet,
  resolveStatusId,
  runPersonDaySet,
  runPersonDayClear,
  runPersonDaySetRange,
  runPersonDayStatusCreate,
  runPersonDayStatusUpdate,
} from "../../src/commands/person/day.js";

const JWT =
  "e30." +
  Buffer.from(JSON.stringify({ ownerAsiakasId: 1349, personId: 1 })).toString("base64url") +
  ".sig";

function makeClient(): MockApiClient {
  return mockApiClient({ getCurrentToken: vi.fn().mockReturnValue(JWT) });
}

describe("runPersonDayStatuses", () => {
  test("projects statusList rows", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([
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
    c.get.mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 2, personPvmText: "ranta", pois: true, personPvmStatus: "L", personPvmStatusName: "Loma" },
    ]);
    const out = await runPersonDayGet(c, 555, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith(
      "/api/personPvm/list/1349?startDate=2026-06-10&endDate=2026-06-10&personId=555"
    );
    expect(out.items[0]).toEqual({
      personPvmId: 91, date: "2026-06-10", statusId: 2, status: "L", pois: true, vehicleId: null, text: "ranta",
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
    c.get.mockResolvedValueOnce([
      { personPvmStatusId: 2, personPvmStatus: "L", personPvmStatusName: "Loma", pois: true, vakioVapaa: false },
    ]);
    const id = await resolveStatusId(c, "loma");
    expect(id).toBe(2);
  });
  test("unknown name exits 4", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([
      { personPvmStatusId: 2, personPvmStatus: "L", personPvmStatusName: "Loma", pois: true, vakioVapaa: false },
    ]);
    await expect(resolveStatusId(c, "nope")).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("runPersonDaySet", () => {
  test("dry-run reads current row, computes wouldChange, never POSTs", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([
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
    c.get.mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 5, personPvmText: null, pois: false, personPvmStatus: "T", personPvmStatusName: "Töissä" },
    ]);
    c.post.mockResolvedValueOnce({ personPvmId: 91 });
    await runPersonDaySet(c, 555, "2026-06-10", "2", { reason: "vacation" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/save/1349",
      { personId: 555, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, vehicleId: null, personPvmId: 91 },
      { headers: { "X-Action-Reason": "vacation" } }
    );
  });

  test("real write: no existing row → POST omits personPvmId (insert)", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([]);
    c.post.mockResolvedValueOnce({ personPvmId: 200 });
    await runPersonDaySet(c, 555, "2026-06-10", "2", { reason: "vacation" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/save/1349",
      { personId: 555, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, vehicleId: null },
      { headers: { "X-Action-Reason": "vacation" } }
    );
  });

  test("real write: preserves the existing vehicleId (does not wipe day driver)", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: 53, pvm: 20260610, personPvmStatusId: 5, personPvmText: null, pois: false, personPvmStatus: "T", personPvmStatusName: "Töissä" },
    ]);
    c.post.mockResolvedValueOnce({ personPvmId: 91 });
    await runPersonDaySet(c, 555, "2026-06-10", "2", { reason: "vacation" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/save/1349",
      { personId: 555, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, vehicleId: 53, personPvmId: 91 },
      { headers: { "X-Action-Reason": "vacation" } }
    );
  });
});

function tokenWith(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

describe("statuses --full", () => {
  test("statuses --full surfaces prefix/style/description/active/ownerAsiakasId", async () => {
    const client = mockApiClient({
      get: vi.fn().mockResolvedValue([ { personPvmStatusId: 4, personPvmStatus: "Pois, loma", personPvmStatusName: "Loma", personPvmStatusDescription: null, pois: true, vakioVapaa: false, prefix: "L", style: "indianred", active: true, ownerAsiakasId: 8 }, ]),
      getCurrentToken: vi.fn().mockReturnValue(tokenWith({ ownerAsiakasId: 8 })),
    });

    const full = await runPersonDayStatuses(client, { full: true });
    expect(full.items[0]).toMatchObject({
      statusId: 4, code: "Pois, loma", name: "Loma", pois: true, vakioVapaa: false,
      description: null, prefix: "L", style: "indianred", active: true, ownerAsiakasId: 8,
    });

    const lean = await runPersonDayStatuses(client, {});
    expect(lean.items[0]).not.toHaveProperty("prefix");
  });
});

describe("runPersonDayClear", () => {
  test("dry-run resolves the row, returns wouldDelete, never DELETEs", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, pois: true, personPvmStatus: "L", personPvmStatusName: "Loma" },
    ]);
    const out = await runPersonDayClear(c, 555, "2026-06-10", { dryRun: true, reason: "x" });
    expect(c.delete).not.toHaveBeenCalled();
    expect(out).toEqual({ dryRun: true, wouldDelete: { personPvmId: 91, date: "2026-06-10", status: "L" } });
  });

  test("real: existing row → DELETE the resolved id", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([
      { personPvmId: 91, personId: 555, vehicleId: null, pvm: 20260610, personPvmStatusId: 2, personPvmText: null, pois: true, personPvmStatus: "L", personPvmStatusName: "Loma" },
    ]);
    c.delete.mockResolvedValueOnce({ deleted: 1 });
    await runPersonDayClear(c, 555, "2026-06-10", { reason: "back to work" });
    expect(c.delete).toHaveBeenCalledWith("/api/personPvm/delete/1349/91", {
      headers: { "X-Action-Reason": "back to work" },
    });
  });

  test("real: no row → no DELETE, returns deleted:false", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([]);
    const out = await runPersonDayClear(c, 555, "2026-06-10", { reason: "x" });
    expect(c.delete).not.toHaveBeenCalled();
    expect(out).toEqual({ deleted: false, message: "no personPvm row for that person/date" });
  });
});

// fb#2945 — 2026-10-30 is a Friday, 10-31 Sat, 11-01 Sun, 11-02 Mon, 11-03 Tue.
const STATUSES = [
  { personPvmStatusId: 5, personPvmStatus: "Pois", personPvmStatusName: "Pois", pois: true, vakioVapaa: false },
  { personPvmStatusId: 6, personPvmStatus: "Pois, viikonloppu", personPvmStatusName: "Viikonloppu", pois: true, vakioVapaa: true },
  { personPvmStatusId: 41, personPvmStatus: "Sairasloma", personPvmStatusName: "Sairasloma", pois: true, vakioVapaa: false },
];

function rangeClient(dayRows: unknown[]): MockApiClient {
  const c = makeClient();
  c.get.mockImplementation(async (path: string) => (path.includes("/statusList/") ? STATUSES : dayRows));
  c.post.mockResolvedValue({ personPvmId: 1 });
  return c;
}

describe("runPersonDaySetRange", () => {
  test("writes every day, preserving vehicle on an existing row, with a per-day idempotency key", async () => {
    const c = rangeClient([
      { personPvmId: 77, pvm: 20261102, personPvmStatusId: 5, personPvmText: "x", vehicleId: 1227, pois: true },
    ]);
    const out = (await runPersonDaySetRange(c, 6381, "2026-11-02", "2026-11-03", "sairasloma", { reason: "r", idempotencyKey: "k" })) as Record<string, unknown>;
    expect(c.get).toHaveBeenCalledWith("/api/personPvm/list/1349?startDate=2026-11-02&endDate=2026-11-03&personId=6381");
    expect(c.post).toHaveBeenCalledTimes(2);
    expect(c.post).toHaveBeenNthCalledWith(
      1,
      "/api/personPvm/save/1349",
      { personId: 6381, pvm: 20261102, personPvmStatusId: 41, personPvmText: "x", vehicleId: 1227, personPvmId: 77 },
      { headers: { "X-Action-Reason": "r", "Idempotency-Key": "k:2026-11-02" } }
    );
    expect(c.post.mock.calls[1][1]).toEqual({ personId: 6381, pvm: 20261103, personPvmStatusId: 41, personPvmText: null, vehicleId: null });
    expect(out.set).toEqual(["2026-11-02", "2026-11-03"]);
  });

  test("--weekdays-only skips Sat/Sun and an existing vakioVapaa day; same-status days are unchanged", async () => {
    const c = rangeClient([
      { personPvmId: 1, pvm: 20261030, personPvmStatusId: 6, personPvmText: null, vehicleId: null, pois: true },
      { personPvmId: 2, pvm: 20261103, personPvmStatusId: 41, personPvmText: null, vehicleId: null, pois: true },
    ]);
    const out = (await runPersonDaySetRange(c, 6381, "2026-10-30", "2026-11-03", "41", { reason: "r", weekdaysOnly: true })) as Record<string, unknown>;
    expect(out.skipped).toEqual([
      { date: "2026-10-30", reason: "vakioVapaa status 6" },
      { date: "2026-10-31", reason: "weekend" },
      { date: "2026-11-01", reason: "weekend" },
    ]);
    expect(out.unchanged).toEqual(["2026-11-03"]);
    expect(out.set).toEqual(["2026-11-02"]);
  });

  test("--dry-run never POSTs", async () => {
    const c = rangeClient([]);
    const out = (await runPersonDaySetRange(c, 6381, "2026-11-02", "2026-11-02", "41", { dryRun: true })) as Record<string, unknown>;
    expect(c.post).not.toHaveBeenCalled();
    expect(out.wouldChange).toEqual([{ date: "2026-11-02", status: { from: null, to: 41 } }]);
  });

  test("rejects a range over the cap and a reversed range", async () => {
    const c = rangeClient([]);
    await expect(runPersonDaySetRange(c, 1, "2026-01-01", "2026-12-31", "41", {})).rejects.toThrow(/at most 186/);
    await expect(runPersonDaySetRange(c, 1, "2026-02-01", "2026-01-01", "41", {})).rejects.toThrow(/before --from/);
    // An impossible calendar date must exit 4 here, not reach the backend as a 500 (fb#2967).
    await expect(runPersonDaySetRange(c, 1, "2026-02-30", "2026-03-03", "41", {})).rejects.toThrow(/expected YYYY-MM-DD/);
    await expect(runPersonDaySetRange(c, 1, "2026-02-25", "2026-04-31", "41", {})).rejects.toThrow(/expected YYYY-MM-DD/);
    expect(c.get).not.toHaveBeenCalled();
  });
});

describe("runPersonDayStatusCreate / Update (fb#2944)", () => {
  const saved = { personPvmStatusId: 41, personPvmStatus: "Sairasloma", personPvmStatusName: "Sairasloma", pois: true, vakioVapaa: false, prefix: "S", style: null, active: true, ownerAsiakasId: 1349, personPvmStatusDescription: null };

  test("create posts id -1 with defaults and projects the saved row", async () => {
    const c = makeClient();
    c.post.mockResolvedValueOnce(saved);
    const out = await runPersonDayStatusCreate(c, { name: "Sairasloma", prefix: "S", reason: "r" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/personPvm/status/save",
      { personPvmStatusId: -1, personPvmStatus: "Sairasloma", personPvmStatusName: "Sairasloma", pois: true, vakioVapaa: false, active: true, prefix: "S", style: null, personPvmStatusDescription: null },
      { headers: { "X-Action-Reason": "r" } }
    );
    expect(out).toMatchObject({ statusId: 41, name: "Sairasloma", ownerAsiakasId: 1349 });
  });

  test("update read-merges: only the given flag changes", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([saved]);
    c.post.mockResolvedValueOnce({ ...saved, active: false });
    await runPersonDayStatusUpdate(c, 41, { active: 0, reason: "r" });
    expect(c.post.mock.calls[0][1]).toEqual({ ...saved, active: false });
  });

  test("update --dry-run reports the diff and never POSTs", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([saved]);
    const out = await runPersonDayStatusUpdate(c, 41, { style: "orange", dryRun: true });
    expect(c.post).not.toHaveBeenCalled();
    expect(out).toEqual({ dryRun: true, statusId: 41, wouldChange: { style: { from: null, to: "orange" } } });
  });

  test("update of an unknown id exits 5", async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([saved]);
    await expect(runPersonDayStatusUpdate(c, 999, { active: 0 })).rejects.toMatchObject({ exitCode: 5 });
  });

  test("a bad --prefix exits 4 before the status-list read (fb#2971)", async () => {
    const c = makeClient();
    await expect(runPersonDayStatusUpdate(c, 999, { prefix: "ABC" })).rejects.toMatchObject({ exitCode: 4 });
    expect(c.get).not.toHaveBeenCalled();
  });

  test('--style "" is sent as empty, which the backend stores as NULL (fb#2971)', async () => {
    const c = makeClient();
    c.get.mockResolvedValueOnce([{ ...saved, style: "orange" }]);
    c.post.mockResolvedValueOnce(saved);
    await runPersonDayStatusUpdate(c, 41, { style: "" });
    expect(c.post.mock.calls[0][1]).toMatchObject({ style: "" });
  });
});

test("runPersonDaySet: an impossible --date exits 4 before any read (fb#2971)", async () => {
  const c = makeClient();
  await expect(runPersonDaySet(c, 555, "2026-02-30", "2", {})).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("--date") });
  expect(c.get).not.toHaveBeenCalled();
});
