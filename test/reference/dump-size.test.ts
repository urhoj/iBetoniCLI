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
const DUMP_LIMIT_BYTES = 630_000; // measured 600,058 B on 2026-08-19 (+5% headroom)
// Largest on 2026-08-19 (post fb#780 trim): ib dev changelog add 11,501 B and
// ib dev changelog update 10,849 B — the known ceiling-setters (their flag
// surface IS the contract; fb#747/fb#757 resolutions should shrink them
// further). Third place is 8,335 B (ib dev feedback create).
const PER_SPEC_LIMIT_BYTES = 12_000;

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
