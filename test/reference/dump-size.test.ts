import { describe, test, expect } from "vitest";
import { buildReference } from "../../src/reference/dump.js";

/**
 * Reference-dump size ratchet (fb#779, reshaped by fb#2386). It used to cap the
 * FULL dump, which every new command tripped however concise it was, so the cap
 * was bumped 68 times (630_000 → 874_000) and stopped meaning anything. These
 * checks trip only on VERBOSITY and on what an agent actually loads:
 *  - mean bytes per spec: a concise new command passes, padding raises the mean;
 *  - the largest loadable `ib reference dump <token>`: what one read costs;
 *  - the largest single spec.
 * When one trips, TRIM first: move rationale and incident history to
 * `ib reference detail set "<cmd>" --field detail`, delete deploy-gate caveats
 * for backends long since deployed, and keep each note to the operational
 * contract. Raise a limit only for growth that is the contract itself, with a
 * one-line reason beside the constant. History: `git log -p` on this file.
 */
const MEAN_SPEC_LIMIT_BYTES = 1_985; // measured 1 962.8 B after the fb#2386 trim
const DOMAIN_DUMP_LIMIT_BYTES = 120_000; // largest unit: jerry, 102 667 B (fb#2386)
const PER_SPEC_LIMIT_BYTES = 11_900; // largest: ib dev changelog add, 11 549 B (fb#2386)

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

  test(`no single spec exceeds ${PER_SPEC_LIMIT_BYTES} bytes in the dump`, () => {
    const offenders = Object.entries(fullDump().commands)
      .map(([name, spec]) => [name, bytes(spec)] as const)
      .filter(([, size]) => size >= PER_SPEC_LIMIT_BYTES);
    expect(
      offenders,
      offenders.map(([name, size]) => `${name} is ${size} B (limit ${PER_SPEC_LIMIT_BYTES}). ${TRIM_HINT}`).join("\n")
    ).toEqual([]);
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
