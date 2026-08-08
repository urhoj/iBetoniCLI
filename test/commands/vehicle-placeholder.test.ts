import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  isPlaceholderVehicleId,
  markPlaceholderVehicles,
} from "../../src/commands/vehicle/placeholder.js";
import {
  runVehicleList,
  runVehicleSearch,
} from "../../src/commands/vehicle/index.js";
import {
  runVehicleDriverBoard,
  runVehicleDriverGaps,
} from "../../src/commands/vehicle/driver.js";

const mockClient = mockApiClient();

/** The tenant-8 sentinel exactly as prod returns it. */
const SENTINEL = { vehicleId: 0, plate: null, name: "Ei tietoa" };
const REAL = { vehicleId: 53, plate: "CRE-974", name: "98 B28 CRE-974" };

describe("isPlaceholderVehicleId", () => {
  test("non-positive ids are placeholders (the ids parseId refuses)", () => {
    expect(isPlaceholderVehicleId(0)).toBe(true);
    expect(isPlaceholderVehicleId(-1)).toBe(true);
  });

  test("real ids are not", () => {
    expect(isPlaceholderVehicleId(1)).toBe(false);
    expect(isPlaceholderVehicleId(53)).toBe(false);
  });

  test("a missing or non-numeric id is not treated as a placeholder", () => {
    expect(isPlaceholderVehicleId(undefined)).toBe(false);
    expect(isPlaceholderVehicleId("0")).toBe(false);
  });
});

describe("markPlaceholderVehicles", () => {
  test("stamps only the sentinel and leaves real rows byte-identical", () => {
    const out = markPlaceholderVehicles({
      items: [SENTINEL, REAL],
      nextCursor: null,
      count: 2,
    });
    expect(out.items[0]).toEqual({ ...SENTINEL, placeholder: true });
    // Absent, not `false` — a real vehicle pays nothing for the sentinel.
    expect(out.items[1]).toEqual(REAL);
    expect("placeholder" in out.items[1]).toBe(false);
  });

  test("passes every other envelope key through untouched", () => {
    const out = markPlaceholderVehicles({
      items: [SENTINEL],
      nextCursor: "abc",
      count: 1,
      truncated: true,
    });
    expect(out.nextCursor).toBe("abc");
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(true);
  });

  test("annotates rather than filters — count and items stay in agreement", () => {
    const out = markPlaceholderVehicles({
      items: [SENTINEL, REAL],
      nextCursor: null,
      count: 2,
    });
    expect(out.items).toHaveLength(2);
    expect(out.count).toBe(2);
  });
});

describe("the four vehicle-row reads all stamp sentinels", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  // All four read dbo.vehicle (list/search share one endpoint; gaps is board
  // filtered server-side), so a sentinel marked on one and bare on another
  // would be a contract the caller could trip on.
  const envelope = { items: [SENTINEL, REAL], nextCursor: null, count: 2 };
  const reads: Array<[string, () => Promise<{ items: Record<string, unknown>[] }>]> = [
    ["vehicle list", () => runVehicleList(mockClient, {})],
    ["vehicle search", () => runVehicleSearch(mockClient, "ei")],
    ["vehicle driver board", () => runVehicleDriverBoard(mockClient, "2026-08-09")],
    ["vehicle driver gaps", () => runVehicleDriverGaps(mockClient, "2026-08-09")],
  ];

  for (const [name, read] of reads) {
    test(`${name} marks the sentinel`, async () => {
      mockClient.get.mockResolvedValueOnce(envelope);
      const out = await read();
      expect(out.items[0].placeholder).toBe(true);
      expect(out.items[1].placeholder).toBeUndefined();
    });
  }
});
