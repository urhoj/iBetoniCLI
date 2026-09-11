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
// 702,000 -> 702,600 on 2026-09-10 (fb#1562): `ib worksite create`'s description and example used field names (name/address/asiakasId) that don't exist on POST /api/tyomaa/new, and omitting the real required field (ownerAsiakasId) 403s at the tenant gate before validation ever runs — a stale example that reads as a permission bug. Fixed the description, example, and added the same explicit 403-vs-400 ERROR row `ib keikka create` already carries for the identical gotcha (fb#1311); 702,407 B measured after trimming prose twice first.
// 702,600 -> 702,800 on 2026-09-11 (fb#1560 follow-up), measured 702,715 B after rebasing onto the fb#1562 bump above: `ib vehicle create` gained --force plus its client-origin duplicate-plate ERROR row (a real vehicle-create call had no check for an already-active same-plate vehicle at all — two independent create passes for the Betomik pilot's fleet produced duplicate rows twice in a row). The row is the point, not padding — hintForError matches on it, so the refusal answers with its own remedy (--force) instead of the generic exit-4 hint. Prose was trimmed twice before this bump; headroom kept deliberately thin (~85 B).
// 702,800 -> 704,300 on 2026-09-11 (Betomik order-book validator, task 6): new CommandSpec `ib dev betomik-orderbook import` (developer-tier, --body/--from-json + the write-safety trio, 3 ERROR rows for the 403/400/client-side-no-payload cases), measured 704,205 B. Headroom kept deliberately thin (~95 B).
const DUMP_LIMIT_BYTES = 704_300;
// Largest on 2026-08-19 (post fb#780 trim): ib dev changelog add 11,501 B and
// ib dev changelog update 10,849 B — the known ceiling-setters (their flag
// surface IS the contract; fb#747/fb#757 resolutions should shrink them
// further). Third place is 8,335 B (ib dev feedback create). Bumped
// 12,000 -> 12,100 on 2026-09-03 (fb#1271): --type gained a fourth accepted
// value (docs), 12,003 B measured on `ib dev changelog add`. 12,100 -> 12,200
// on 2026-09-04 (fb#1294): one note saying --type/--area are server-validated
// and can lag a fresh CLI release, 12,183 B measured on `ib dev changelog add`.
// 12,200 -> 12,500 on 2026-09-05 (fb#1350/1351/1328): `ib dev changelog add`
// gained the betonipumppu tier-2 token plus a previously-MISSING errors[] row
// for its own repo-token rejection (12,469 B); `ib dev feedback list`'s single
// combined mutual-exclusion errors row (whose remedy bled into every violation
// regardless of which was actually hit) was split into 4 rows each carrying
// only its own remedy (12,337 B) — both trimmed hard first (REPO_FLAG_DESC and
// every new remedy shortened) before reaching for this bump. 12,500 -> 13,400
// on 2026-09-05 (fb#1421): `ib dev feedback list` gained --min-age plus its
// errors[] row and one freshness note (13,373 B). This spec was ALREADY within
// ~120 B of the cap, so any new flag on it required a bump; the prose was cut
// three times first (the flag description and note both roughly halved, the
// incident rationale moved out of the spec entirely) and only the operational
// contract kept.
const PER_SPEC_LIMIT_BYTES = 13_400;

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
