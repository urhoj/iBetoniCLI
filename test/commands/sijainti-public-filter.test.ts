/**
 * `ib sijainti list --public / --private` — the cross-tenant exposure lens.
 *
 * isPublic moved from the location TYPE to the ROW on 2026-08-14, so two rows of
 * the SAME type can now differ. The filter that matters operationally is
 * `--type betoniasema --all --private`: it names every concrete plant customers
 * CANNOT see, which is otherwise a silent failure — a private plant simply never
 * appears in the tehdas picker and the keikka editor quietly auto-selects a
 * farther one.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runSijaintiListJoined } from "../../src/commands/sijainti/index.js";

const mockClient = mockApiClient();

// Raw backend shape (a bare array of sijaintiTypeSelite rows), NOT a
// ListEnvelope — runSijaintiTypes projects it. Mirrors sijainti-read.test.ts.
const TYPE_ROWS = [
  { sijaintiTypeId: 1, sijaintiTypeSelite: "Betoniasema" },
  { sijaintiTypeId: 2, sijaintiTypeSelite: "Jäteasema" },
];

/** Two rows of the SAME type that differ only in visibility — the whole point. */
const ROWS = [
  { sijaintiId: 1, name: "Published plant", type: 1, isPublic: true },
  { sijaintiId: 2, name: "Withheld plant", type: 1, isPublic: false },
  { sijaintiId: 3, name: "Depot", type: 2, isPublic: false },
];

describe("ib sijainti list — visibility filter", () => {
  const get = mockClient.get;
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/geocode/sijaintiTypes")) return TYPE_ROWS;
      if (path.startsWith("/api/cli/sijainti/list"))
        return { items: ROWS, nextCursor: null, count: ROWS.length };
      throw new Error(`unexpected GET ${path}`);
    });
  });

  test("no flag filters nothing", async () => {
    const r = await runSijaintiListJoined(mockClient, {});
    expect(r.items.map((x) => x.sijaintiId)).toEqual([1, 2, 3]);
  });

  test("--public keeps only published rows", async () => {
    const r = await runSijaintiListJoined(mockClient, { public: true });
    expect(r.items.map((x) => x.sijaintiId)).toEqual([1]);
  });

  test("--private keeps only private rows — the exposure audit", async () => {
    const r = await runSijaintiListJoined(mockClient, { public: false });
    expect(r.items.map((x) => x.sijaintiId)).toEqual([2, 3]);
  });

  test("rows of the SAME type are separated — impossible under the old type flag", async () => {
    const r = await runSijaintiListJoined(mockClient, { public: false });
    const sameType = r.items.filter((x) => Number(x.type) === 1);
    expect(sameType.map((x) => x.sijaintiId)).toEqual([2]);
  });

  test("1/0 is coerced, not identity-compared", async () => {
    // The field is a JSON boolean over the CLI route, but 1/0 from anything
    // reading the BIT column raw.
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/geocode/sijaintiTypes")) return TYPE_ROWS;
      return {
        items: [
          { sijaintiId: 10, type: 1, isPublic: 1 },
          { sijaintiId: 11, type: 1, isPublic: 0 },
        ],
        nextCursor: null,
        count: 2,
      };
    });
    const pub = await runSijaintiListJoined(mockClient, { public: true });
    expect(pub.items.map((x) => x.sijaintiId)).toEqual([10]);
  });

  test("an older backend omitting the field yields NOTHING for --public", async () => {
    // Deploy-gated and asymmetric: --public matches nothing there while
    // --private matches everything. Pinned so the asymmetry is a known
    // property rather than a surprise mid-audit.
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/geocode/sijaintiTypes")) return TYPE_ROWS;
      return {
        items: [{ sijaintiId: 20, type: 1 }, { sijaintiId: 21, type: 1 }],
        nextCursor: null,
        count: 2,
      };
    });
    expect((await runSijaintiListJoined(mockClient, { public: true })).items).toEqual([]);
    expect(
      (await runSijaintiListJoined(mockClient, { public: false })).items.map((x) => x.sijaintiId)
    ).toEqual([20, 21]);
  });

  test("combines with --type", async () => {
    const r = await runSijaintiListJoined(mockClient, { type: "1", public: false });
    expect(r.items.map((x) => x.sijaintiId)).toEqual([2, 3]);
  });
});
