import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runArgv } from "../../src/runArgv.js";
import { todayHelsinki } from "../../src/dates.js";
import {
  runVehicleDriverBoard,
  runVehicleDriverGaps,
  runVehicleDriverAvailable,
  runVehicleDriverWho,
  runVehicleDriverHistory,
  runVehicleDriverAssign,
  runVehicleDriverClear,
  runVehicleDefaultGet,
  runVehicleDefaultSet,
} from "../../src/commands/vehicle/driver.js";

const c = mockApiClient();

const LIST = { items: [], nextCursor: null, count: 0 };
const get = () => c.get;
const post = () => c.post;

describe("ib vehicle driver reads", () => {
  beforeEach(() => vi.clearAllMocks());

  test("board resolves date alias to yyyymmdd path", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverBoard(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/board/20260610");
  });

  test("gaps hits the gaps path", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverGaps(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/gaps/20260610");
  });
  test("available hits the available path", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverAvailable(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/available/20260610");
  });

  test("who hits /who/:vehicleId/:yyyymmdd", async () => {
    get().mockResolvedValueOnce({ vehicleId: 53, date: "2026-06-10", driver: null });
    await runVehicleDriverWho(c, 53, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/who/53/20260610");
  });

  test("history encodes vehicleId + from/to", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverHistory(c, 53, { from: "2026-06-01", to: "2026-06-30" });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/history/53?from=2026-06-01&to=2026-06-30");
  });
});

describe("ib vehicle driver writes", () => {
  beforeEach(() => vi.clearAllMocks());

  test("assign posts {vehicleId,personId,yyyymmdd} with reason header", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDriverAssign(c, 53, 555, "2026-06-10", { reason: "auto-fill" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/driver/assign",
      { vehicleId: 53, personId: 555, yyyymmdd: 20260610 },
      { headers: { "X-Action-Reason": "auto-fill" } }
    );
  });

  test("assign --dry-run sends X-Dry-Run", async () => {
    post().mockResolvedValueOnce({ dryRun: true });
    await runVehicleDriverAssign(c, 53, 555, "2026-06-10", { dryRun: true, reason: "preview" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/driver/assign",
      { vehicleId: 53, personId: 555, yyyymmdd: 20260610 },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "preview" } }
    );
  });

  test("clear posts {vehicleId,yyyymmdd} with reason header", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDriverClear(c, 53, "2026-06-10", { reason: "breakdown" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/driver/clear",
      { vehicleId: 53, yyyymmdd: 20260610 },
      { headers: { "X-Action-Reason": "breakdown" } }
    );
  });
});

describe("ib vehicle driver default", () => {
  beforeEach(() => vi.clearAllMocks());

  test("get projects defaultDriverId off the vehicle record", async () => {
    get().mockResolvedValueOnce({ vehicleId: 53, defaultDriverId: 555, plate: "ABC-1" });
    const out = await runVehicleDefaultGet(c, 53);
    expect(c.get).toHaveBeenCalledWith("/api/cli/vehicle/get/53");
    expect(out).toEqual({ vehicleId: 53, defaultDriverPersonId: 555 });
  });

  test("get yields null when no default driver", async () => {
    get().mockResolvedValueOnce({ vehicleId: 53, plate: "ABC-1" });
    const out = await runVehicleDefaultGet(c, 53);
    expect(out).toEqual({ vehicleId: 53, defaultDriverPersonId: null });
  });

  test("set posts {vehicleId,personId} to setDefaultPumppari", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDefaultSet(c, 53, 555, { reason: "permanent driver" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/setDefaultPumppari",
      { vehicleId: 53, personId: 555 },
      { headers: { "X-Action-Reason": "permanent driver" } }
    );
  });

  test("clear posts personId:null to setDefaultPumppari", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDefaultSet(c, 53, null, { reason: "driver left" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/setDefaultPumppari",
      { vehicleId: 53, personId: null },
      { headers: { "X-Action-Reason": "driver left" } }
    );
  });
});

/**
 * feedback #393: the day-keyed leaves were positional-only while their
 * `vehicle timeline` / `route` / `visits` siblings take `--date`, so an agent
 * moving between them spent a whole failed call on argument shape. Both
 * spellings now parse, and the guard runs BEFORE getClient — an argument
 * mistake must not surface as an auth failure the caller fixes first.
 */
describe("ib vehicle driver — date positional OR --date (fb#393)", () => {
  // Guard-only invocations: they exit 4 before any request, so the
  // (unreachable) endpoint is never dialled.
  const opts = { token: "t", endpoint: "http://127.0.0.1:9" };
  const errorOf = (stderr: string): string => JSON.parse(stderr).error;

  // `before` is everything up to the date slot; `after` the flags that follow
  // (the two writes hard-require --reason, the reads take none).
  const DATE_LEAVES = [
    { leaf: "board", before: ["vehicle", "driver", "board"], after: [] as string[] },
    { leaf: "gaps", before: ["vehicle", "driver", "gaps"], after: [] as string[] },
    { leaf: "available", before: ["vehicle", "driver", "available"], after: [] as string[] },
    { leaf: "who", before: ["vehicle", "driver", "who", "53"], after: [] as string[] },
    { leaf: "clear", before: ["vehicle", "driver", "clear", "53"], after: ["--reason", "x"] },
    {
      leaf: "assign",
      before: ["vehicle", "driver", "assign", "53"],
      after: ["--person", "555", "--reason", "x"],
    },
  ];

  test.each(DATE_LEAVES)("$leaf: neither positional nor --date -> exit 4", async ({ before, after }) => {
    const r = await runArgv([...before, ...after], opts);
    expect(r.exitCode).toBe(4);
    expect(errorOf(r.stderr)).toMatch(/missing date.*--date/s);
  });

  test.each(DATE_LEAVES)("$leaf: conflicting positional and --date -> exit 4", async ({ before, after }) => {
    const r = await runArgv([...before, "2026-06-10", "--date", "2026-06-11", ...after], opts);
    expect(r.exitCode).toBe(4);
    expect(errorOf(r.stderr)).toMatch(/differ/);
  });

  test("assign: --date is accepted (no unknown-option rejection)", async () => {
    // A parse rejection would be code USAGE; getting past the parser to the
    // dead endpoint is what proves the flag is wired.
    const r = await runArgv(
      ["vehicle", "driver", "assign", "53", "--date", "2026-06-10", "--person", "555", "--reason", "x"],
      opts
    );
    expect(r.exitCode).not.toBe(4);
    expect(r.stderr).not.toMatch(/unknown option/i);
  });

  test("board: a same-day pair written two ways is NOT a conflict", async () => {
    const r = await runArgv(["vehicle", "driver", "board", "today", "--date", todayHelsinki()], opts);
    expect(r.exitCode).not.toBe(4);
  });
});

/**
 * fb#776: an EMPTY board/gaps list conflates 'everything eligible already has
 * a driver' with 'nothing is grid-eligible on this date'. The envelope's
 * `hint` must say which, and define grid-eligibility, so the caller needs no
 * second command. Non-empty lists carry no hint.
 */
describe("ib vehicle driver — empty board/gaps disambiguation (fb#776)", () => {
  beforeEach(() => vi.clearAllMocks());

  const day = "2026-08-20";
  const fleet = (count: number, truncated?: boolean) => ({
    items: [],
    nextCursor: null,
    count,
    ...(truncated ? { truncated: true } : {}),
  });
  const boardRows = (n: number) => ({
    items: Array.from({ length: n }, (_, i) => ({ vehicleId: i + 1, hasDriver: true })),
    nextCursor: null,
    count: n,
  });

  test("gaps empty BUT board non-empty -> 'all eligible already have a driver'", async () => {
    get().mockResolvedValueOnce(LIST); // gaps
    get().mockResolvedValueOnce(boardRows(2)); // board (for the count)
    const out = await runVehicleDriverGaps(c, day);
    expect(out.hint).toMatch(/all 2 grid-eligible vehicles already have a driver/);
    expect(out.hint).toMatch(/showInGrid/);
  });

  test("gaps empty AND board empty -> 'NO vehicle is grid-eligible' + fleet count", async () => {
    get().mockResolvedValueOnce(LIST); // gaps
    get().mockResolvedValueOnce(LIST); // board
    get().mockResolvedValueOnce(fleet(22)); // vehicle list (for the fleet count)
    const out = await runVehicleDriverGaps(c, day);
    expect(out.hint).toMatch(/NO vehicle is grid-eligible on 2026-08-20/);
    expect(out.hint).toMatch(/22 vehicles/);
    expect(out.hint).toMatch(/lastDate/);
    const fleetCall = c.get.mock.calls.find(([p]) => String(p).startsWith("/api/cli/vehicle/list"));
    expect(fleetCall?.[0]).toBe("/api/cli/vehicle/list?limit=500");
  });

  // fb#918: the default backend limit (100) undercounts fleets bigger than
  // that — the fetch now asks for the route's max (500) explicitly, and when
  // even that is truncated the wording says "at least N" rather than lying
  // that N is the whole fleet.
  test("fleet fetch truncated at 500 -> hint says 'at least 500 vehicles'", async () => {
    get().mockResolvedValueOnce(LIST); // gaps
    get().mockResolvedValueOnce(LIST); // board
    get().mockResolvedValueOnce(fleet(500, true)); // vehicle list, capped + truncated
    const out = await runVehicleDriverGaps(c, day);
    expect(out.hint).toMatch(/at least 500 vehicles/);
  });

  test("board empty reuses its own zero count (no second board fetch)", async () => {
    get().mockResolvedValueOnce(LIST); // board
    get().mockResolvedValueOnce(fleet(5)); // vehicle list
    const out = await runVehicleDriverBoard(c, day);
    expect(out.hint).toMatch(/NO vehicle is grid-eligible/);
    const boardCalls = c.get.mock.calls.filter(([p]) =>
      String(p).startsWith("/api/cli/driver/board/")
    );
    expect(boardCalls).toHaveLength(1);
  });

  test("non-empty gaps carries no hint", async () => {
    get().mockResolvedValueOnce(boardRows(1)); // gaps with one row
    const out = await runVehicleDriverGaps(c, day);
    expect(out.hint).toBeUndefined();
    expect(c.get).toHaveBeenCalledTimes(1); // no disambiguation fetches
  });

  test("a disambiguation fetch failure degrades to the bare definition, never throws", async () => {
    get().mockResolvedValueOnce(LIST); // gaps empty
    get().mockRejectedValueOnce(new Error("board exploded")); // board fetch fails
    const out = await runVehicleDriverGaps(c, day);
    expect(out.hint).toMatch(/grid-eligible/);
    expect(out.hint).toMatch(/showInGrid/);
  });
});
