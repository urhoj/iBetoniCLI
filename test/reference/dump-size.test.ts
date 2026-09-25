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
// 704,300 -> 704,600 on 2026-09-11 (fb#1500/fb#1483/fb#1532, fb#1525): split `ib dev schema query`'s single "Guard rejection or SQL error" ERROR row into a shape-guard row and a genuine-SQL-error row — the old combined remedy always opened with the guard-rejection framing ("rephrase to a single read statement") even for a real SQL Server error, where the statement's shape was never the problem; plus corrected `ib worksite create`'s PERMISSIONS/403 remedy from the FE-only `auth.page.tyomaa.edit` (never evaluated server-side, fb#1525) to the real `keikkaEdit` company-role tier gate on --body.ownerAsiakasId (fb#1434). Measured 704,465 B. Headroom kept deliberately thin (~135 B).
// 704,600 -> 713,000 on 2026-09-11 (fb#1563/fb#1564): five new `ib dev apikey`
// leaves (sources/list/verify/set/revoke) — the first write path ever added
// for dbo.apiKeys, which previously required a developer to hand-write a prod
// SQL INSERT. 712,703 B measured (headroom ~300 B, deliberately thin); the five specs are real new capability
// (write-safety trio + reasonPolicy on two, plus the "never returns the
// value" contract worth stating explicitly), not padding.
// 713,000 -> 714,600 on 2026-09-11 (fb#1321, fb#1512): `ib customer search` gained
// --own-only, a note naming the cross-tenant hit class (the search admits self-owned
// foreign company rows; ownerAsiakasId is now projected so a caller can tell), and a
// CORRECTED outputShape (the old ListEnvelope<{…, score}> described a payload the
// route never returned — it is a raw array). `ib keikka list` gained --asiakas (the
// did-you-mean used to point it at --customer, a DIFFERENT dimension) plus its 403
// row. Prose trimmed twice first; 714,246 B measured. Headroom ~350 B, deliberately thin.
// 714,600 -> 716,200 on 2026-09-11 (fb#1381/1431/1521, +#1420/1436): `ib dev changelog
// get` gained --full (no-op, sibling symmetry) and an outputShape naming the SIX fields
// not spelled like their flags; `ib betoni laatu list` gained --limit plus the
// never-paginated note; `feedback cluster` lists its relations/related aliases. All of
// it answers filed discoverability misses. 715,861 B measured. Headroom ~340 B.
// 716,200 -> 716,600 on 2026-09-12 (fb#1644): `feedback create`/`update` --gate-ref
// gained the client-side 200-char cap — one help-text clause each plus the errors
// row the ERRORS-drift rule requires for a new failWith string; prose trimmed
// first. ~716,470 B measured. Headroom ~130 B.
// 716,600 -> 718,944 on 2026-09-12 (tenant weekly report): two new read leaves
// `ib dev betomik-orderbook runs` / `rows <runId>` over the validator's existing GET
// routes — the read side the weekly Betomik report sums m³ and groups plates from;
// 718,644 B measured. Headroom ~300 B, deliberately thin.
// 718,944 -> 722,400 on 2026-09-12 (rebased onto the bump above): new domain
// `ib grid palkki-type create` (Kalle Urho Oy -> Betomik Oy palkki-type
// replication surfaced there was no `ib` write capability for
// grid_palkkiTypes at all) — 15 flags, 3 error rows, 2 notes;
// description/flags/notes trimmed twice first (was 4,476 B over the
// pre-rebase limit, cut to 3,375 B over). One new command, not padding on an
// existing one. 722,153 B measured after rebase. Headroom ~250 B.
// 722,153 -> 727,960 B on 2026-09-12: three new `ib dev betomik-orderbook`
// leaves (review / propose / ai-stats — the human-override + AI-proposer
// loop of the Betomik pilot) plus the rows outputShape gaining the
// rowKind/vehicle/ai columns. Headroom ~240 B.
// 727,960 -> 743,327 B on 2026-09-12: `ib grid palkki-type create` re-homed as
// `ib palkki type create` and the domain filled out — palkki list/get/create/
// update/delete + type list/update/delete (8 new leaves over new
// /api/cli/palkki/* adapter routes; palkki ROWS had no `ib` capability at
// all, which the Betomik order-book sync needs next). Headroom ~270 B.
// 2026-09-13: +5 betomik-orderbook sync commands (sync / resync /
// extract-prompt / exceptions / audit) — the write-then-verify loop that
// closes the Betomik order-book pipeline (import -> review/propose -> sync).
// 748,339 B measured; limit raised to that + 2,000 B headroom.
// 750,339 -> 750,100 on 2026-09-12 (final review of the betomik-orderbook
// specs): `sync`/`resync` gained dry-run notes (a dry run still writes ledger
// state and still pays for extractions), `--digest` now says it SENDS MAIL,
// `audit` says what it actually lists (auto-created entities, not keikkas) and
// `exceptions` names its columns. 749,754 B measured — a net +1,415 B, but the
// previous bump's 2,000 B of unearned headroom is handed back at the same
// time, so the limit TIGHTENS. Headroom kept thin (~346 B) per this file's
// convention: growth stays a decision, not a drift.
// 2026-09-13 (fb#1683): +14 foreign-key leaves — `ib person|customer|vehicle
// fk sources/list/set/remove` (+ `person fk import`) over the pre-existing
// backend routes; the Betomik driver-nickname load (T5) had no `ib` path at
// all. 771,734 B measured; limit = that + ~350 B, same thin headroom.
// Bumped 772_100 -> 785_000 for the `ib palkki color` command group (6 new
// leaves: list/get/create/update/delete/reorder — grid bar-coloring rules,
// "Palkkiväritykset"; fb#1690/fb#1694).
// 785_000 -> 785_200 on 2026-09-14 (fb#1513/fb#1693): `ib auth login` gained
// --print-token (+flag row +outputShape clause +example); the shared
// --from-json flag description (hoisted, so paid once) now states both
// accepted key spellings and that the write-safety trio is never a JSON key
// (fb#1693 — the old text implied only one spelling and never mentioned the
// trio exclusion). Prose trimmed twice first (from +212 B to +84 B over the
// prior limit) before reaching for this bump; 785,084 B measured. Headroom
// ~116 B, thin per this file's convention.
// 795_000 since fb#1763 (ib person merge gained a 50203 day-row conflict error row).
// 798_500 since fb#1724 (2026-09-16): a whole new leaf, `ib dev betomik-orderbook
// sync-row` — the per-row export whose dry-run-first pass is the Betomik import
// method (three notes encode it; prose trimmed once before this bump).
// 798061 B measured; headroom ~439 B, thin per this file's convention.
// 799_000 (fb#1750/fb#1722 spec notes, 2026-09-16).
// 802_500 since the fb#1736/1723/1732/1743/1712/1607/1733 cluster (2026-09-16):
// four flags + three error rows on `betomik-orderbook rows` (paging/filter),
// the --asiakas alias note on four person fk leaves, the palkki get/color get
// asymmetry pair, the from-json merge-key spellings on glossary set, and ten
// other-tenant 403 remedies that now name `--company <ownerId>` (the shared
// constant is longer than the switch-only wording it replaced).
// 801959 B measured; headroom ~541 B, thin per this file's convention.
// 803_000 (fb#1606 from-json value-type contract in the glossary set/import
// spec rows, 2026-09-16). ~802.7 KB measured.
// 803_000 → 805_000 (fb#1751): `auth switch`/`company switch` gained a
// positional arg, two USAGE rows and an example each (+~1.1 KB, measured 804 099 B).
// 805_000 → 806_000 (fb#1766/1776/1788, 2026-09-17): `company list --search`
// (flag + note + example), the lookup-row round-trip clause on `glossary set
// --from-json`, and the column-name did-you-mean on `dev schema query`'s SQL
// error row. Measured 805 112 B after one trim pass; headroom ~888 B.
// 806_000 → 811_000 (fb#1363/1499/1638/1789, 2026-09-17): the new `dev feedback
// reopen` spec (+~3.4 KB), bash item 5 on shell-quoting, the follow-up clause on
// `link --type`, the definition-function sentence on `dev schema query`. Measured
// 810 006 B; after the fb#1816 trims + `reopen --from-json` 810 363 B, so the cap
// sits at 811_000 — headroom ~637 B, thin per this file's convention.
// Bumped for the Betomik tick dashboard's two new specs (tick-report, tick-runs).
// 815_000 → 816_000 (fb#1844/fb#1820, 2026-09-19): the shared ASIAKAS_TARGET_ERR
// row on `customer settings/modules/operator` (hoisted once + three @id refs) and
// `worksite update`'s outputShape now naming the re-read record. Measured
// 815 498 B after trimming both strings once; master was already within ~100 B.
// 816_000 → 819_000 (2026-09-20): `ib keikka update` grew the grid's drag-and-drop
// (--vehicle/--date/--start/--end → /api/cli/keikka/move) — four flags, five exit-4
// guard rows and two notes. Measured 818 424 B after trimming the row's strings once.
// 819_000 → 822_000 (2026-09-20): fb#1833/#1443/#1407 quick-win batch — `feedback
// claim --also` (one flag, examples row), `auth logout --dry-run` (one flag +
// outputShape line), `validate person|company <id>` (one arg, four exit-4 rows,
// one note, two examples). Measured 821 231 B.
// 822_000 → 824_000 (2026-09-20): fb#1802/#1838/#1721 feedback-queue batch — two
// brand-new commands `ib person default-company get`/`set` (fb#1838, full specs
// incl. errors/notes/dry-run), a `seeAlso` cross-reference on `betomik-orderbook
// review` (fb#1802), and a new `--owner` flag + note on `customer list` (fb#1721).
// Measured 823 702 B after one trim pass on the new specs' notes.
// 824_000 → 825_000 (2026-09-21): fb#1744/fb#1910 `keikka get` — the six pump /
// free-text fields in outputShape (the --full flag shipped and was dropped the
// same day; the longer outputShape is what remains). Measured 824 097 B.
// 825_000 → 827_000 (2026-09-22): fb#1914 — new leaf `ib keikka tilat`
// (+ `statuses` alias), the keikkaTila catalogue every keikka row's numeric
// `tila` points at. Agents had to read dbo.keikkaTila directly to name a
// status; `ib person day statuses` already had the equivalent for personPvm.
// One new command with 4 notes, not padding on an existing one. Measured
// 826 262 B. Headroom ~740 B, thin per this file's convention.
// 827_000 → 828_500 (2026-09-24): new `ib keikka copy` (wraps POST /api/keikka/copy;
// branch from 2026-09-07 finally merged). Trimmed once first (one note and the
// long description/flag prose cut). One new command, not padding. Measured
// 828 387 B. Headroom ~110 B.
// 828_500 → 830_000 (2026-09-24): new `ib person app-seen` (Kuskit v1a seen-stamp
// read, task 6). One new command, not padding. Measured 829 469 B. Headroom ~531 B.
// 830_000 → 831_000 (2026-09-25): `ib dev betomik-orderbook runs --limit/--offset`
// (fb#1953, error rows reuse `rows`' wording) + the zero-deleted shape on
// `ib dev cache invalidate` (fb#1985). Measured 830 761 B. Headroom ~239 B.
const DUMP_LIMIT_BYTES = 831_000;
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
    // Next 1000 above the measurement, mirroring every bump in the history above.
    const nextLimit = Math.ceil((size + 1) / 1000) * 1000;
    const today = new Date().toISOString().slice(0, 10);
    const fmt = (n: number, sep = "_") => n.toLocaleString("en-US").replaceAll(",", sep);
    expect(
      size,
      `full dump is ${size} B (limit ${DUMP_LIMIT_BYTES}), ${size - DUMP_LIMIT_BYTES + 1} B over. ` +
        `If this growth is deliberate: in test/reference/dump-size.test.ts set ` +
        `\`const DUMP_LIMIT_BYTES = ${fmt(nextLimit)};\` and add the history line ` +
        `\`// ${fmt(DUMP_LIMIT_BYTES)} → ${fmt(nextLimit)} (${today}): <what grew>. Measured ${fmt(size, " ")} B.\` ` +
        `above it, then justify it in the commit message; otherwise trim ` +
        `(notes -> \`ib reference detail set\`; see notes-budget-baseline.json).`
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
