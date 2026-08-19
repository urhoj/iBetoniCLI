// schedule specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { permErrors } from "./shared.js";

// fb#777: schedule answers for the ACTIVE company only, unlike its sibling
// `ib stats` (which offers --all for a cross-tenant rollup) — a bare 0-row
// result gave no signal that other tenants were never searched. The scope
// echo turns a scoped zero into a self-evidently scoped zero.
const SCHEDULE_SCOPE_NOTE =
  "Scoped to the ACTIVE company only — the echoed `scope.asiakasId` names which tenant was queried, so a 0-row result reads as \"none in THIS company\", not \"none scheduled anywhere\". For a cross-tenant rollup, use `ib stats --all` instead (a different aggregate shape, not a keikka list).";

export const SCHEDULE_SPECS: CommandSpec[] = [

  // ─── schedule (3) ────────────────────────────────────────────────────────
  {
    command: "ib schedule today",
    description:
      "List today's keikkas for the active company. Wrapper around `ib keikka list --from today --to today`.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }> & { scope: { asiakasId } }",
    errors: permErrors("auth.page.grid.tilaus.read"),
    notes: [SCHEDULE_SCOPE_NOTE],
    seeAlso: ["ib stats"],
    examples: ["ib schedule today", "ib schedule today --pretty"],
  },
  {
    command: "ib schedule day",
    description: "List keikkas for a specific day.",
    permissions: ["auth.page.grid.tilaus.read"],
    args: [{ name: "date", type: "date", description: "date (YYYY-MM-DD or today/yesterday/tomorrow)" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }> & { scope: { asiakasId } }",
    errors: permErrors("auth.page.grid.tilaus.read"),
    notes: [SCHEDULE_SCOPE_NOTE],
    seeAlso: ["ib stats"],
    examples: ["ib schedule day 2026-06-01", "ib schedule day tomorrow"],
  },
  {
    command: "ib schedule week",
    description:
      "List keikkas for a 7-day window starting at the given date.",
    permissions: ["auth.page.grid.tilaus.read"],
    args: [{ name: "start", type: "date", description: "week start date (YYYY-MM-DD or today/yesterday/tomorrow)" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }> & { scope: { asiakasId } }",
    errors: permErrors("auth.page.grid.tilaus.read"),
    notes: [SCHEDULE_SCOPE_NOTE],
    seeAlso: ["ib stats"],
    examples: ["ib schedule week 2026-06-01", "ib schedule week today"],
  },
];
