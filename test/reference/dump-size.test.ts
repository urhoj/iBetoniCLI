import { describe, test, expect } from "vitest";
import { buildReference } from "../../src/reference/dump.js";
import baseline from "./dump-size-baseline.json" with { type: "json" };

/**
 * Reference-dump size ratchet (fb#779, reshaped by fb#2386). It used to cap the
 * FULL dump, which every new command tripped however concise it was, so the cap
 * was bumped 68 times (630_000 → 874_000) and stopped meaning anything. These
 * checks trip only on VERBOSITY and on what an agent actually loads:
 *  - mean bytes per spec: a concise new command passes, padding raises the mean;
 *  - the largest loadable `ib reference dump <token>`: what one read costs;
 *  - each single spec: held to PER_SPEC_LIMIT_BYTES unless it has its own
 *    shrink-only ceiling in dump-size-baseline.json (fb#1423 — a global limit
 *    set by the largest spec let every other spec grow to that size too).
 * When one trips, TRIM first: move rationale and incident history to
 * `ib reference detail set "<cmd>" --field detail`, delete deploy-gate caveats
 * for backends long since deployed, and keep each note to the operational
 * contract. Raise a limit only for growth that is the contract itself, with a
 * one-line reason beside the constant. History: `git log -p` on this file.
 */
const MEAN_SPEC_LIMIT_BYTES = 1_985; // measured 1 962.8 B after the fb#2386 trim
const DOMAIN_DUMP_LIMIT_BYTES = 120_000; // largest unit: jerry, 102 667 B (fb#2386)
const PER_SPEC_LIMIT_BYTES = 6_000; // default for unlisted specs; largest unlisted: ib reference detail set, 5 804 B (fb#1423)
const ceilings: Record<string, number> = baseline.ceilings;

const TRIM_HINT =
  "Trim first: move rationale/incident history to `ib reference detail set \"<cmd>\" --field detail`, " +
  "delete deploy-gate caveats for long-deployed backends, keep notes to the operational contract.";

const fullDump = () => buildReference(undefined, "developer", []);
const bytes = (x: unknown) => JSON.stringify(x).length;

/**
 * The units an agent loads with `ib reference dump <token>`: every top-level
 * domain except `dev` (a whole developer subtree nobody loads at once), plus
 * each `dev <subgroup>` — `buildReference` resolves a bare subgroup name.
 */
function loadableTokens(commands: Record<string, unknown>): string[] {
  const paths = Object.keys(commands).map((c) => c.split(" ").slice(1));
  const domains = new Set(paths.map((p) => p[0]).filter((d) => d !== "dev"));
  const devGroups = new Set(paths.filter((p) => p[0] === "dev" && p.length > 2).map((p) => p[1]));
  return [...domains, ...devGroups];
}

describe("reference dump size ratchet (fb#779, fb#2386)", () => {
  test(`the mean spec stays under ${MEAN_SPEC_LIMIT_BYTES} bytes`, () => {
    const specs = Object.values(fullDump().commands);
    const mean = specs.reduce((sum, s) => sum + bytes(s), 0) / specs.length;
    expect(
      mean,
      `mean spec is ${mean.toFixed(1)} B over ${specs.length} specs (limit ${MEAN_SPEC_LIMIT_BYTES}). ` +
        `A concise new command lowers the mean, so this means existing prose grew. ${TRIM_HINT}`
    ).toBeLessThan(MEAN_SPEC_LIMIT_BYTES);
  });

  test(`no loadable dump exceeds ${DOMAIN_DUMP_LIMIT_BYTES} bytes`, () => {
    const offenders = loadableTokens(fullDump().commands)
      .map((t) => [t, bytes(buildReference(t, "developer", []))] as const)
      .filter(([, size]) => size >= DOMAIN_DUMP_LIMIT_BYTES);
    expect(
      offenders,
      offenders
        .map(([t, size]) => `\`ib reference dump ${t}\` is ${size} B (limit ${DOMAIN_DUMP_LIMIT_BYTES}). ${TRIM_HINT} Or split the group.`)
        .join("\n")
    ).toEqual([]);
  });

  test(`no spec exceeds ${PER_SPEC_LIMIT_BYTES} bytes unless baselined (and never above its ceiling)`, () => {
    const failures: string[] = [];
    for (const [name, spec] of Object.entries(fullDump().commands)) {
      const size = bytes(spec);
      const ceiling = ceilings[name];
      if (ceiling !== undefined) {
        if (size > ceiling) {
          failures.push(
            `${name} grew to ${size} B (ceiling ${ceiling} B). ${TRIM_HINT} Ceilings are shrink-only: ` +
              `do NOT raise the entry in test/reference/dump-size-baseline.json casually — a raise is a reviewed decision.`
          );
        }
      } else if (size > PER_SPEC_LIMIT_BYTES) {
        failures.push(
          `${name} is ${size} B (limit ${PER_SPEC_LIMIT_BYTES}). ${TRIM_HINT} ` +
            `If the size is the contract itself, add '"${name}": ${size}' to test/reference/dump-size-baseline.json in the same PR.`
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("liveness: every baselined spec still exists, still exceeds the default, and its ceiling is not above actual", () => {
    const commands = fullDump().commands as Record<string, unknown>;
    const stale: string[] = [];
    for (const [name, ceiling] of Object.entries(ceilings)) {
      if (!(name in commands)) {
        stale.push(`${name}: no longer in the dump — delete its baseline entry`);
        continue;
      }
      const size = bytes(commands[name]);
      if (size <= PER_SPEC_LIMIT_BYTES) {
        stale.push(`${name}: now ${size} B (<= ${PER_SPEC_LIMIT_BYTES}) — delete its baseline entry`);
      } else if (ceiling > size) {
        stale.push(`${name}: ceiling ${ceiling} B is above the actual ${size} B — lower it to ${size}`);
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  test("loadable units are the non-dev domains plus each dev subgroup, never the whole `dev` tree", () => {
    const tokens = loadableTokens(fullDump().commands);
    expect(tokens).toContain("jerry");
    expect(tokens).toContain("feedback");
    expect(tokens).not.toContain("dev");
  });
});

import { buildCommandsList } from "../../src/reference/commandsList.js";

describe("commands --signatures size (fb#779)", () => {
  const SIGNATURES_LIMIT_BYTES = 150_000;
  test(`the full signatures list stays under ${SIGNATURES_LIMIT_BYTES} bytes`, () => {
    const size = JSON.stringify(buildCommandsList({ signatures: true }, "developer")).length;
    expect(
      size,
      `signatures list is ${size} B (limit ${SIGNATURES_LIMIT_BYTES}) — it exists to be the` +
        ` cheap middle rung between \`ib commands --all\` and the full dump; if it stops being` +
        ` cheap, trim flag surfaces or bump deliberately in the same PR.`
    ).toBeLessThan(SIGNATURES_LIMIT_BYTES);
  });
});
