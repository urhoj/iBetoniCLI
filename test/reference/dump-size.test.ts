import { describe, test, expect } from "vitest";
import { buildReference } from "../../src/reference/dump.js";

/**
 * fb#779 — dump size ratchet. The full `ib reference dump` grew +252% between
 * June and August 2026 (~180 KB -> 635 KB) and nothing made that growth a
 * decision: leaf-spec additions land one at a time and the artifact quietly
 * became too large for a context window. These limits turn growth into a
 * deliberate act.
 *
 * If a limit trips and the growth is intentional, bump the constant IN THE
 * SAME PR and justify it in the commit message; otherwise trim (move notes to
 * the DB detail tier — see test/reference/notes-budget-baseline.json — or
 * extend the shared-row hoist). Never bump casually: every byte here is paid
 * by every AI that ingests the dump.
 */
const DUMP_LIMIT_BYTES = 700_000; // measured 665,945 B on 2026-08-31 after the fb#1040/fb#1081 spec rows (+5% headroom). Deliberate growth: `auth whoami`/`auth refresh` gained the endpoint-aware not-logged-in rows (fb#1040 — the remedy used to drop the endpoint), and `sijainti update` documented --show-on-map/--hide-on-map (fb#1081).
// Largest on 2026-08-19 (post fb#780 trim): ib dev changelog add 11,501 B and
// ib dev changelog update 10,849 B — the known ceiling-setters (their flag
// surface IS the contract; fb#747/fb#757 resolutions should shrink them
// further). Third place is 8,335 B (ib dev feedback create). Bumped
// 12,000 -> 12,100 on 2026-09-03 (fb#1271): --type gained a fourth accepted
// value (docs), 12,003 B measured on `ib dev changelog add`. 12,100 -> 12,200
// on 2026-09-04 (fb#1294): one note saying --type/--area are server-validated
// and can lag a fresh CLI release, 12,183 B measured on `ib dev changelog add`.
const PER_SPEC_LIMIT_BYTES = 12_200;

describe("reference dump size ratchet (fb#779)", () => {
  test(`the full developer dump stays under ${DUMP_LIMIT_BYTES} bytes`, () => {
    const size = JSON.stringify(buildReference(undefined, "developer", [])).length;
    expect(
      size,
      `full dump is ${size} B (limit ${DUMP_LIMIT_BYTES}). If this growth is deliberate, ` +
        `bump DUMP_LIMIT_BYTES in the same PR and justify it in the commit message; ` +
        `otherwise trim (notes -> \`ib reference detail set\`; see notes-budget-baseline.json).`
    ).toBeLessThan(DUMP_LIMIT_BYTES);
  });

  test(`no single spec exceeds ${PER_SPEC_LIMIT_BYTES} bytes in the dump`, () => {
    const ref = buildReference(undefined, "developer", []);
    const offenders = Object.entries(ref.commands)
      .map(([name, spec]) => [name, JSON.stringify(spec).length] as const)
      .filter(([, size]) => size >= PER_SPEC_LIMIT_BYTES);
    expect(
      offenders,
      offenders
        .map(
          ([name, size]) =>
            `${name} is ${size} B (limit ${PER_SPEC_LIMIT_BYTES}). If deliberate, bump ` +
            `PER_SPEC_LIMIT_BYTES in the same PR; otherwise trim its notes/flag prose ` +
            `(move business context to \`ib reference detail set\`).`
        )
        .join("\n")
    ).toEqual([]);
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
