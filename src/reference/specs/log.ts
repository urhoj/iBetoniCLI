// log specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, limitErr, authErrors, LOG_CAPPED_NOTE, LOG_FIELD_HINT_NOTE, LIMIT_500_FLAG, OWNER_ASIAKAS_FLAG } from "./shared.js";

export const LOG_SPECS: CommandSpec[] = [

  // ─── log (6) ─────────────────────────────────────────────────────────────
  {
    command: "ib log entity",
    description:
      "Change-tracker audit trail for ONE entity of any type — who changed which field, when, old→new, and the --reason recorded by writes. GET /api/changes/:entityType/:entityId/:ownerAsiakasId; owner defaults to the active company. entityType is validated client-side against the offline catalog (`ib log types`); 'keikka' folds in the keikka's keikkaBetoni rows; deprecated 'kuski' is accepted with a stderr note. --field filters client-side AFTER the server's --limit page — on a capped page an empty result means 'not in the newest --limit changes', NOT 'this field never changed' (the envelope then carries a hint; raise --limit or use `ib log by-entity-date`).",
    auth: "any",
    args: [
      { name: "entityType", type: "string", description: "One of `ib log types` (e.g. keikka, vehicle, pumppuRequest)" },
      { name: "entityId", type: "number", description: "The entity's id (see entityIdMeaning in `ib log types`)" },
    ],
    flags: [
      OWNER_ASIAKAS_FLAG,
      LIMIT_500_FLAG,
      { name: "field", type: "string", description: "Filter by changeTracker fieldName (client-side)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName, keikkaTilaContext, deviceType }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      apiErr(403, "Not a member of that company — or entityType personAvailability without an admin role", "ib company switch to that owner, or use an admin token"),
      { origin: "client", exit: 4, meaning: "Unknown entityType (client-side validation)", remedy: "ib log types" }
    ),
    notes: [
      "personAvailability is admin-gated server-side; every other type needs company membership only.",
      "Shortcuts: ib keikka|vehicle|worksite log (same row shape) and ib person|customer log (slimmer rows without entityType/entityId).",
    ],
    seeAlso: ["ib log types", "ib keikka log", "ib log latest"],
    examples: [
      "ib log entity keikka 12345 --field kuskit",
      "ib log entity vehicle 53 --field vehicleRegNo",
      "ib log entity pumppuRequest 17",
    ],
  },
  {
    command: "ib log latest",
    description:
      "Newest changes across the whole active company, optionally one entityType — admin view for 'what just happened'. GET /api/changes/latest/:ownerAsiakasId. NOTE: reason/impersonator columns appear only after the 2026-06 aggregate-procs backend deploy; until then they are null.",
    permissions: ["isAnyAdmin (asiakasAdmin/laskuAdmin/system admin)"],
    flags: [
      { name: "entity-type", type: "string", description: "Filter to one entityType" },
      OWNER_ASIAKAS_FLAG,
      { name: "limit", type: "number", default: "100", description: "Max rows (server cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName, keikkaTilaContext, deviceType }>" +
      LOG_CAPPED_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; the server caps at 500 — use `ib log range --from/--to` to reach older rows"),
      apiErr(403, "Not an admin in the owner company", "use an admin token, or per-entity `ib log entity`")
    ),
    seeAlso: ["ib log range", "ib log by-entity-date"],
    examples: ["ib log latest", "ib log latest --entity-type keikka --limit 50"],
  },
  {
    command: "ib log range",
    description:
      "All changes MADE within a time window (by change timestamp), optional entityType/person filters — admin forensic view. GET /api/changes/range/:ownerAsiakasId. The backend has no row cap; --limit slices client-side (truncated:true when cut). NOTE: reason/impersonatedByPersonName are null until the 2026-06 aggregate-procs backend deploy.",
    permissions: ["isAnyAdmin (asiakasAdmin/laskuAdmin/system admin)"],
    flags: [
      { name: "from", type: "date", description: "Window start, YYYY-MM-DD or ISO datetime (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "Window end, YYYY-MM-DD or ISO datetime (or today/yesterday/tomorrow)", required: true },
      { name: "entity-type", type: "string", description: "Filter to one entityType" },
      { name: "person", type: "number", description: "Filter to one actor personId (a non-integer value exits 4 client-side)" },
      OWNER_ASIAKAS_FLAG,
      { name: "limit", type: "number", default: "200", description: "Max rows kept client-side (cap 2000)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName }> (+truncated when --limit cut rows)",
    errors: authErrors(
      limitErr("pass a positive integer; rows are kept client-side and cap at 2000 — narrow `--from` / `--to` rather than raising the cap"),
      apiErr(403, "Not an admin in the owner company", "use an admin token"),
      // `match` scopes the row to the date guard: it is the command's only
      // client/exit-4 row, so without it the exit-only fallback served "use
      // YYYY-MM-DD" for a non-integer --person too (fb#385).
      { origin: "client", exit: 4, match: "must be YYYY-MM-DD", meaning: "Invalid --from/--to (client-side)", remedy: "use YYYY-MM-DD or ISO datetime; today/yesterday/tomorrow are also accepted" },
      apiErr(400, "Backend rejected the dates", "use ISO date strings")
    ),
    seeAlso: ["ib log by-entity-date"],
    examples: [
      "ib log range --from 2026-06-01 --to 2026-06-10",
      "ib log range --from yesterday --to today --entity-type keikka --person 63",
    ],
  },
  {
    command: "ib log by-entity-date",
    description:
      "Changes affecting deliveries DATED in the window — filters by the entity's own date (keikka.pumppuAika / grid_palkit.starttime), NOT the change timestamp. This is what the grid Muutoshistoria drawer shows: 'everything that touched that day's deliveries, whenever the change was made'. GET /api/changes/by-entity-date/:ownerAsiakasId. Admin only. NOTE: reason/impersonatedByPersonName are null until the 2026-06 aggregate-procs backend deploy.",
    permissions: ["isAnyAdmin (asiakasAdmin/laskuAdmin/system admin)"],
    flags: [
      { name: "entity-type", type: "string", description: "keikka or palkki", required: true },
      { name: "from", type: "date", description: "Entity-date window start (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "Entity-date window end (or today/yesterday/tomorrow)", required: true },
      OWNER_ASIAKAS_FLAG,
      { name: "limit", type: "number", default: "200", description: "Max rows kept client-side (cap 2000)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personName, at, description, keikkaTilaContext, deviceType, palkkiText, palkkiVehicleRegNo, reason, impersonatedByPersonName }> (+truncated when --limit cut rows)",
    errors: authErrors(
      apiErr(403, "Not an admin in the owner company", "use an admin token"),
      { origin: "client", exit: 4, meaning: "entityType not keikka|palkki, or bad dates (client-side)", remedy: "use --entity-type keikka|palkki and ISO dates or today/yesterday/tomorrow" }
    ),
    seeAlso: ["ib log range"],
    examples: ["ib log by-entity-date --entity-type keikka --from today --to today"],
  },
  {
    command: "ib log user",
    description:
      "Changes MADE BY a person. Without personId: your own recent changes (GET /api/changes/user/recent/:owner — any member). With personId: that person's changes (GET /api/changes/user/:personId/:owner — self or admin). Rows carry entityDisplayName (e.g. '12345 - Tilaus') instead of personName (the actor IS the queried person).",
    auth: "any",
    args: [
      { name: "personId", type: "number", required: false, description: "Whose changes (omit = yourself; others need admin)" },
    ],
    flags: [
      OWNER_ASIAKAS_FLAG,
      { name: "limit", type: "number", default: "100", description: "Max rows (cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, at, description, deviceType, entityDisplayName, reason, impersonatedByPersonName }>" +
      LOG_CAPPED_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; this cursor-less route caps at 500 — raise --limit, or use `ib log range --person <id> --from`/`--to` for a date-ranged view"),
      apiErr(403, "Another person's history without an admin role", "omit personId, or use an admin token")
    ),
    examples: ["ib log user", "ib log user 63 --limit 50"],
  },
  {
    command: "ib log types",
    description:
      "Offline catalog of changeTracker entityTypes: what each entityId means, the server-side read gate, and notes (deprecated kuski, keikka⊃keikkaBetoni fold-in, pumppuRequest two-party rows). No network, no auth.",
    auth: "none",
    flags: [],
    outputShape: "ListEnvelope<{ entityType, entityIdMeaning, gate: 'member'|'admin', notes, deprecated? }>",
    errors: [{ origin: "client", exit: 0, meaning: "Always succeeds (offline static list)", remedy: "n/a" }],
    examples: ["ib log types"],
  },
];
