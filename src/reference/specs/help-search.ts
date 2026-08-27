// help-search specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { COMMON_AUTH_ERRORS, SEARCH_ALIAS_FLAG, intParseErr } from "./shared.js";

export const HELP_SEARCH_SPECS: CommandSpec[] = [

  // ─── help (1) ────────────────────────────────────────────────────────────
  {
    command: "ib help",
    description: "Concept guides for AI users. No arg lists topic ids; `ib help <topic>` prints one guide. Unknown topics fall back to `ib glossary lookup` (DB-backed).",
    auth: "none",
    args: [{ name: "topic", type: "string", required: false, description: "topic id (roles, jerry-lifecycle, write-safety, exit-codes, multi-tenancy, log, attachments) or a vocabulary term resolved via the DB glossary" }],
    flags: [],
    outputShape: "no arg: { items:[{id,title}], nextCursor:null, count } | with topic: { id, title, body }",
    errors: [{ origin: "client", exit: 5, meaning: "Unknown topic", remedy: "run `ib help` to list valid topic ids; or `ib glossary lookup <term>` for vocabulary" }],
    examples: ["ib help", "ib help write-safety", "ib help tila"],
  },

  // ─── search (1) ──────────────────────────────────────────────────────────
  {
    command: "ib search",
    description:
      "Cross-entity unified search: customers, worksites, persons, vehicles, keikkas and sijainnit in ONE flat ranked list. Client-side parallel fan-out over the per-entity searches — use this to resolve \"who/what is X\" without guessing the entity type.",
    auth: "any",
    args: [{ name: "query", type: "string", required: false, description: "Search string (or pass --search)" }],
    flags: [
      SEARCH_ALIAS_FLAG,
      { name: "in", type: "string", description: "Comma-separated subset of: customer,worksite,person,vehicle,keikka,sijainti" },
      { name: "limit", type: "number", default: "5", description: "Max hits per entity" },
      { name: "my-companies", type: "boolean", description: "Search across every company you belong to (customer/worksite/person)" },
    ],
    outputShape:
      "{ items: [{ entity, id, label, detail, <nativeIdField> }], nextCursor: null, count, errors: [{ entity, message }] }",
    errors: [intParseErr("--limit", "pass a positive integer"), ...COMMON_AUTH_ERRORS],
    notes: [
      "A failing/denied entity degrades gracefully into errors[] — exit 0 if at least one entity succeeded; if ALL fail, exits with the first failure's mapped code.",
      "Ordering: prefix label matches first, then entity order customer→worksite→person→vehicle→keikka→sijainti.",
      "Each hit carries its native id field (asiakasId/tyomaaId/personId/vehicleId/keikkaId/sijaintiId) for a follow-up `ib <entity> get <id>`.",
      "Sijainti is matched by name/address/typeName substring (type names like \"jäteasema\" match too) over scope=all — INCLUDING other companies' rows (supplier betoniasemat referenced by GPS visits/timeline). Newer backends pre-filter server-side; older ones return the own+shared 500-row scan and the filter runs client-side.",
      "--my-companies covers customer/worksite/person only; vehicle and keikka stay scoped to the active company (sijainti is already scope=all).",
    ],
    examples: [
      "ib search kamppi",
      "ib search 0401234567 --in person,keikka",
      "ib search \"Rudus\" --in customer --limit 10",
      "ib search jäteasema --in sijainti",
    ],
  },
];
