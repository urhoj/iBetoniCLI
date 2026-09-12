import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  buildPalkkiBody,
  composeInstant,
  runPalkkiList,
  runPalkkiGet,
  runPalkkiCreate,
  runPalkkiUpdate,
  runPalkkiDelete,
} from "../../src/commands/palkki/index.js";

const mockClient = mockApiClient();

beforeEach(() => {
  mockClient.get.mockReset();
  mockClient.post.mockReset();
  mockClient.delete.mockReset();
});

describe("composeInstant / buildPalkkiBody", () => {
  test("Helsinki wall-clock → ISO instant, DST-aware (EEST in September, EET in January)", () => {
    expect(composeInstant("2026-09-14", "07:00", "--start")).toBe("2026-09-14T04:00:00.000Z");
    expect(composeInstant("2026-01-14", "07:00", "--start")).toBe("2026-01-14T05:00:00.000Z");
  });

  test("rejects a non-HH:MM time client-side (exit 4)", () => {
    expect(() => composeInstant("2026-09-14", "7", "--start")).toThrow(expect.objectContaining({ exitCode: 4 }));
  });

  test("typed flags map to the backend body and win over --body; times need a date", () => {
    const body = buildPalkkiBody(
      { text: "from-body", extra: "kept" },
      { vehicle: 53, date: "2026-09-14", start: "07:00", end: "16:00", type: "huolto", text: "typed", keikka: 9, worksite: 4, owner: 27, style: "x" }
    );
    expect(body).toEqual({
      extra: "kept",
      vehicleId: 53,
      type: "huolto",
      text: "typed",
      attachedKeikkaId: 9,
      tyomaaId: 4,
      ownerAsiakasId: 27,
      style: "x",
      timeStart: "2026-09-14T04:00:00.000Z",
      timeEnd: "2026-09-14T13:00:00.000Z",
    });
    // No date → no instants composed (the update action fills the date from the row first).
    expect(buildPalkkiBody({}, { start: "08:00" })).toEqual({});
  });
});

describe("run* functions", () => {
  test("list builds the query string; get hits /get/:id", async () => {
    mockClient.get.mockResolvedValue({ items: [], count: 0, nextCursor: null });
    await runPalkkiList(mockClient, { date: "2026-09-14", vehicle: 53, deleted: true });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/palkki/list?date=2026-09-14&vehicle=53&deleted=1");
    await runPalkkiList(mockClient, { from: "2026-09-14", to: "2026-09-20", owner: 27 });
    expect(mockClient.get).toHaveBeenLastCalledWith("/api/cli/palkki/list?from=2026-09-14&to=2026-09-20&owner=27");
    await runPalkkiGet(mockClient, 4821);
    expect(mockClient.get).toHaveBeenLastCalledWith("/api/cli/palkki/get/4821");
  });

  test("create forwards body + all three write-flag headers; missing required fields exit 4 with no POST", async () => {
    mockClient.post.mockResolvedValueOnce({ savedPalkki: { palkkiId: 1 } });
    const body = { vehicleId: 53, type: "huolto", timeStart: "a", timeEnd: "b" };
    await runPalkkiCreate(mockClient, body, { dryRun: true, idempotencyKey: "k", reason: "r" });
    expect(mockClient.post).toHaveBeenCalledWith("/api/cli/palkki/create", body, {
      headers: { "X-Dry-Run": "1", "Idempotency-Key": "k", "X-Action-Reason": "r" },
    });
    await expect(runPalkkiCreate(mockClient, { vehicleId: 53 }, {})).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringContaining("type, timeStart, timeEnd"),
    });
    expect(mockClient.post).toHaveBeenCalledTimes(1);
  });

  test("update posts the partial body to /update/:id; empty body exits 4; delete hits DELETE /delete/:id", async () => {
    mockClient.post.mockResolvedValueOnce({ savedPalkki: {} });
    await runPalkkiUpdate(mockClient, 4821, { text: "x" }, { reason: "r" });
    expect(mockClient.post).toHaveBeenCalledWith("/api/cli/palkki/update/4821", { text: "x" }, { headers: { "X-Action-Reason": "r" } });
    await expect(runPalkkiUpdate(mockClient, 4821, {}, {})).rejects.toMatchObject({ exitCode: 4 });
    mockClient.delete.mockResolvedValueOnce({ dryRun: true, wouldDelete: { palkkiId: 4821 } });
    expect(await runPalkkiDelete(mockClient, 4821, { dryRun: true })).toEqual({ dryRun: true, wouldDelete: { palkkiId: 4821 } });
    expect(mockClient.delete).toHaveBeenCalledWith("/api/cli/palkki/delete/4821", { headers: { "X-Dry-Run": "1" } });
    // The live route answers null (the proc has no result set) → a real ack.
    mockClient.delete.mockResolvedValueOnce(null);
    expect(await runPalkkiDelete(mockClient, 4821, {})).toEqual({ deleted: true, palkkiId: 4821 });
  });
});

describe("ib palkki list — range flag guards (action level)", () => {
  const opts = { token: "t", endpoint: "http://127.0.0.1:9" };

  test("--to without --from exits 4 instead of silently listing today (fb#1669)", async () => {
    const { runArgv } = await import("../../src/runArgv.js");
    const r = await runArgv(["palkki", "list", "--to", "2026-10-01"], opts);
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatch(/--to needs --from/);
  });

  test("--date combined with --from exits 4", async () => {
    const { runArgv } = await import("../../src/runArgv.js");
    const r = await runArgv(["palkki", "list", "--date", "today", "--from", "2026-10-01"], opts);
    expect(r.exitCode).toBe(4);
  });
});
