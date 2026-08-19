import { describe, test, expect } from "vitest";
import { buildReference, expandSharedRows, hoistSharedRows } from "../../src/reference/dump.js";

/**
 * fb#779 — the shared-row hoist. Repeated flag/error rows are stored once in
 * `sharedFlags`/`sharedErrors` and referenced as "@id" strings; these tests
 * pin the round-trip (expand(hoist(x)) === x), reference integrity, and the
 * liveness of the hoist itself (so the guard cannot rot into a no-op).
 */
describe("reference dump shared-row hoist (fb#779)", () => {
  for (const tier of ["developer", "standard"] as const) {
    test(`round-trip: expanding the ${tier} dump reproduces every spec exactly`, () => {
      const ref = buildReference(undefined, tier, []);
      const expanded = expandSharedRows(ref);
      // Re-hoisting the expanded map must reproduce the hoisted form — i.e. the
      // hoist is deterministic and lossless in both directions.
      const rehoisted = hoistSharedRows(expanded);
      expect(rehoisted.commands).toEqual(ref.commands);
      expect(rehoisted.sharedFlags).toEqual(ref.sharedFlags);
      expect(rehoisted.sharedErrors).toEqual(ref.sharedErrors);
      // And the expanded specs carry no reference strings at all.
      for (const spec of Object.values(expanded)) {
        expect(spec.flags.every((f) => typeof f === "object")).toBe(true);
        expect(spec.errors.every((e) => typeof e === "object")).toBe(true);
      }
    });
  }

  test("round-trip holds under --lean too", () => {
    const lean = buildReference(undefined, "developer", [], true);
    const expanded = expandSharedRows(lean);
    const rehoisted = hoistSharedRows(expanded);
    expect(rehoisted.commands).toEqual(lean.commands);
  });

  test("every @id reference resolves; no orphan map entries", () => {
    const ref = buildReference(undefined, "developer", []);
    const usedFlagIds = new Set<string>();
    const usedErrorIds = new Set<string>();
    for (const [name, spec] of Object.entries(ref.commands)) {
      for (const f of spec.flags) {
        if (typeof f !== "string") continue;
        expect(f.startsWith("@"), `${name}: malformed flag ref ${f}`).toBe(true);
        expect(ref.sharedFlags[f.slice(1)], `${name}: dangling flag ref ${f}`).toBeDefined();
        usedFlagIds.add(f.slice(1));
      }
      for (const e of spec.errors) {
        if (typeof e !== "string") continue;
        expect(e.startsWith("@"), `${name}: malformed error ref ${e}`).toBe(true);
        expect(ref.sharedErrors[e.slice(1)], `${name}: dangling error ref ${e}`).toBeDefined();
        usedErrorIds.add(e.slice(1));
      }
    }
    // Every map entry is referenced by at least one spec (no dead weight).
    expect([...Object.keys(ref.sharedFlags)].sort()).toEqual([...usedFlagIds].sort());
    expect([...Object.keys(ref.sharedErrors)].sort()).toEqual([...usedErrorIds].sort());
  });

  test("liveness: the known heavy repeats ARE hoisted", () => {
    // `--reason` is declared verbatim on ~32 specs and the sysadmin-403 row on
    // ~22 — if these ever stop being hoisted, the hoist has silently died.
    const ref = buildReference(undefined, "developer", []);
    expect(ref.sharedFlags["reason"]).toMatchObject({ name: "reason" });
    const sharedErrorRows = Object.values(ref.sharedErrors);
    expect(sharedErrorRows.length).toBeGreaterThan(10);
    expect(
      sharedErrorRows.some((e) => e.exit === 3),
      "at least one shared 403/permission row"
    ).toBe(true);
    // Threshold contract: every hoisted row is genuinely repeated >= 4 times.
    const expanded = expandSharedRows(ref);
    const countOf = (needle: string) =>
      Object.values(expanded).reduce(
        (n, spec) =>
          n +
          [...spec.flags, ...spec.errors].filter((r) => JSON.stringify(r) === needle).length,
        0
      );
    for (const row of [...Object.values(ref.sharedFlags), ...sharedErrorRows]) {
      expect(countOf(JSON.stringify(row))).toBeGreaterThanOrEqual(4);
    }
  });

  test("the hoisted dump is strictly smaller than its expanded form", () => {
    const ref = buildReference(undefined, "developer", []);
    const expandedSize = JSON.stringify(expandSharedRows(ref)).length;
    const hoistedSize =
      JSON.stringify(ref.commands).length +
      JSON.stringify(ref.sharedFlags).length +
      JSON.stringify(ref.sharedErrors).length;
    expect(hoistedSize).toBeLessThan(expandedSize);
  });

  test("expandSharedRows throws on a dangling reference", () => {
    expect(() =>
      expandSharedRows({
        commands: {
          "ib x": {
            command: "ib x",
            description: "d",
            flags: ["@nope"],
            outputShape: "o",
            errors: [],
            examples: ["ib x"],
          },
        },
        sharedFlags: {},
        sharedErrors: {},
      })
    ).toThrowError(/unresolvable shared-flag reference: @nope/);
  });
});
