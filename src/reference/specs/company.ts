// company specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, COMMON_AUTH_ERRORS, intParseErr } from "./shared.js";

export const COMPANY_SPECS: CommandSpec[] = [

  // ─── company (6) ─────────────────────────────────────────────────────────
  {
    command: "ib company list",
    description:
      "List the companies the current user can act on — name, the roles held there, and the active one marked `current: true`. The one-call answer to 'where can I act, as what'.",
    auth: "any",
    flags: [],
    outputShape:
      "ListEnvelope<{ asiakasId, name, current, roles }> = { items, nextCursor, count }",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      // whoami holds the roles but no names (the JWT carries a name only for the
      // ACTIVE company), so the names could not go the other way without making
      // the pure, no-I/O whoami do a network call — the roles came here instead
      // (fb#380).
      "`roles` are read from your own JWT, so they cost no extra round-trip. `[]` = membership with no roles (a real state), not an error.",
      "`ib auth whoami` reports the same memberships but names only the ACTIVE company — use this command when you need the names.",
    ],
    seeAlso: ["ib auth whoami", "ib company switch"],
    examples: ["ib company list", "ib company list --pretty"],
  },
  {
    command: "ib company current",
    description:
      "Return the record of the active company (the one bound to the current JWT).",
    auth: "any",
    flags: [],
    outputShape: "{ asiakasId, name }",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      "The asiakasId to pass to `ib customer modules` / `ib customer settings` when the tenant you want to configure is your OWN company.",
    ],
    seeAlso: ["ib customer modules", "ib customer settings"],
    examples: ["ib company current"],
  },
  {
    command: "ib company switch",
    description:
      "Switch the active company. Alias of `ib auth switch`. Persists the rotated JWT.",
    auth: "any",
    // Same classification as `ib auth switch`: local-state write, gated under read-only.
    mutates: true,
    flags: [
      {
        name: "to",
        type: "number",
        description: "Target asiakasId to switch to",
      },
    ],
    outputShape: "{ ok: true, activeCompany: { asiakasId, name } }",
    errors: [
      apiErr(403, "No access to target", "verify via `ib company list`"),
      {
        origin: "client",
        exit: 3,
        meaning: "Read-only mode active (--read-only / IB_READ_ONLY)",
        remedy:
          "persisted switch is blocked under read-only; use the per-command global --company <id> ephemeral context",
      },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Persists a rotated JWT bound to the target company — blocked under read-only mode (exit 3).",
      "For a one-command company context that does NOT persist, use the global `--company <id>` flag instead.",
    ],
    examples: ["ib company switch --to 1349"],
  },
  {
    command: "ib validate",
    description:
      "Validate a company OR a single employee against a profile — a pass/fail/skip checklist with Finnish details naming what is missing. Entity is inferred from --person: absent → company (profiles: jerry, betoni; --profile required); present → person (profile: onboarding, default). `ib validate list` lists profiles. Company: GET /api/validation/:profile/:asiakasId. Person: GET /api/validation/person/:profile/:asiakasId/:personId.",
    permissions: [
      "company: system admin OR admin-tier role in the target (or owner) company",
      "person: the above OR HR admin (typeId 24) of the target company",
    ],
    args: [
      { name: "action", type: "string", required: false, description: "Use 'list' to list available profiles; omit to run validation." },
    ],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (default: active company)" },
      { name: "person", type: "number", description: "Validate this person as an employee (switches to person validation)" },
      { name: "profile", type: "string", description: "Profile id (company: jerry|betoni, required; person: onboarding, default)" },
      { name: "keikka", type: "number", description: "Validate this keikka against the reminders-drawer rules (alias of `ib keikka validate <id>`)" },
    ],
    outputShape:
      "list: ListEnvelope<{ id, titleFi, description, entity:'company'|'person' }>. company: { entity:'company', profile, asiakasId, asiakasNimi, ok, summary, checks[] }. person: { entity:'person', profile, asiakasId, asiakasNimi, personId, personNimi, ok, summary, checks:[{ id, severity, status:'pass'|'fail'|'skip', titleFi, detail? }] }.",
    errors: [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not an admin/HR of the target company", "use an admin/HR token"),
      apiErr(404, "Unknown profile for that entity, or company/person not found", "run `ib validate list` to see profiles"),
      intParseErr("--keikka", "pass a keikkaId"),
      { origin: "client", exit: 4, match: ["Company validation needs --profile", "must be a positive integer"], meaning: "Missing --profile for company validation, or a non-positive --asiakas/--person", remedy: "pass --profile (jerry|betoni) for a company, or a positive --asiakas/--person; run `ib validate list`" },
    ],
    notes: [
      "ok = every applicable 'required' check passes; skipped checks (conditional, not applicable) and recommended/optional never flip it.",
      "status 'skip' = the check did not apply (e.g. Ajoneuvot-moduuli only checked for pumppari); excluded from summary counts.",
      "Exit code is 0 even when ok:false — the JSON carries the outcome.",
      "Deploy-gated: returns 404 until /api/validation is deployed.",
      "'ib company validate' was renamed to this command (exit 4 on the old path).",
    ],
    seeAlso: ["ib person get", "ib customer modules", "ib jerry admin detail"],
    examples: [
      "ib validate list",
      "ib validate --asiakas 8 --profile betoni",
      "ib validate --asiakas 8 --person 10",
      "ib validate --person 10 --profile onboarding",
      "ib validate --keikka 9001",
    ],
  },
  {
    command: "ib company validate",
    description:
      "Renamed to the top-level `ib validate` (clean break). This path now exits 4 with a hint. Use `ib validate --asiakas <id> --profile <p>` (company) or `ib validate --asiakas <id> --person <id>` (employee).",
    permissions: ["none (always errors)"],
    flags: [],
    outputShape: "(none — always an error envelope)",
    errors: [
      { origin: "client", exit: 4, meaning: "'ib company validate' was renamed to 'ib validate'", remedy: "use `ib validate --asiakas <id> --profile <p>` (company) or `ib validate --asiakas <id> --person <id>` (employee)" },
    ],
    notes: [
      "Clean-break rename (mirrors the ib changes→ib log rename). The command is hidden and only emits the rename hint.",
    ],
    seeAlso: ["ib validate list"],
    examples: ["ib validate list", "ib validate --asiakas 8 --profile betoni"],
  },
  // (The `ib company modules|settings` signpost specs were retired with their
  // commands — the sibling-group resolver in unknownCommand.ts answers now.)

  // ─── betoni (5) — concrete reference data, read-only (fb#426) ────────────
  {
    command: "ib betoni laatu list",
    description:
      "List the concrete grades one supplier can offer (GET /api/betoni/laatu/list/:betoniToimittajaAsiakasId): its OWN rows plus the shared (yhteinen) ones, in sortNum order. Each row carries a derived `shared` boolean so the two populations the response mixes can be told apart.",
    auth: "any",
    flags: [
      { name: "asiakas", type: "number", description: "Supplier (betoniToimittajaAsiakasId) whose catalogue to read; default = your active company" },
      { name: "search", type: "string", description: "Client-side substring filter over laatuNimike / laatuLyhenne / laatuSelite" },
      { name: "shared-only", type: "boolean", description: "Only the shared (asiakasId 0) grades" },
      { name: "own-only", type: "boolean", description: "Only the supplier's own grades (excludes the shared ones)" },
    ],
    outputShape:
      "ListEnvelope<{ laatuId, laatuNimike, laatuLyhenne, laatuLaji, laatuSelite, sortNum, asiakasId, shared, isEnabled, showInDropDown, laatuAllowedS, laatuAllowedRae, laatuAllowedC, laatuShortCuts, laatuHelpId }>",
    prettyColumns: ["laatuId", "laatuNimike", "laatuLyhenne", "asiakasId", "shared", "isEnabled", "sortNum"],
    errors: [
      { origin: "client", exit: 4, match: "mutually exclusive", meaning: "--shared-only and --own-only both given", remedy: "they name two disjoint sets — pass one, or neither for both" },
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --asiakas <supplierId>, or `ib auth switch`" },
      { http: 400, exit: 4, meaning: "Invalid betoniToimittajaAsiakasId", remedy: "--asiakas must be a non-negative integer" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
    ],
    notes: [
      "asiakasId 0 is the SHARED (yhteinen) grade pool visible to every tenant; anything else is that supplier's own. The backend returns both in one list with no marker — `shared` is derived client-side.",
      "Deliberately NOT restricted to your own tenant: a customer legitimately reads its SUPPLIER's catalogue, which is why the backend scopes the cache key by supplier rather than by caller.",
      "The rows come from betoniLaatuView. laatuAllowedRae/laatuAllowedS/laatuAllowedC are expressed in the vocabularies `ib betoni reference` returns.",
    ],
    seeAlso: ["ib betoni laatu get", "ib betoni reference"],
    examples: [
      "ib betoni laatu list",
      "ib betoni laatu list --asiakas 8 --shared-only",
      "ib betoni laatu list --search rapid --pretty",
    ],
  },
  {
    command: "ib betoni laatu get",
    aliases: ["ib betoni laatu show"],
    description:
      "One concrete grade by laatuId. Resolved from the supplier's list rather than a get endpoint (the backend mounts no route for `betoniLaatu.get`), so visibility is identical to `laatu list` — you can only get a grade you could already list.",
    auth: "any",
    args: [{ name: "laatuId", type: "number", description: "laatuId (the PK of betoniLaatu)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Supplier whose catalogue to search; default = your active company" },
    ],
    outputShape: "{ laatuId, laatuNimike, laatuLyhenne, laatuLaji, laatuSelite, sortNum, asiakasId, shared, isEnabled, showInDropDown, ... }",
    errors: [
      { origin: "client", exit: 5, match: "not found in this supplier's catalogue", meaning: "no such grade in the resolved catalogue", remedy: "`ib betoni laatu list` to see it; a grade owned by ANOTHER supplier needs --asiakas <supplierId>" },
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --asiakas <supplierId>, or `ib auth switch`" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
    ],
    seeAlso: ["ib betoni laatu list"],
    examples: ["ib betoni laatu get 42", "ib betoni laatu get 42 --asiakas 8"],
  },
  {
    command: "ib betoni attr list",
    description:
      "List concrete additives (betoniAttr) for one supplier under one owning tenant (GET /api/betoni/attr/list/:betoniAsiakasId/:ownerAsiakasId). Both scope columns treat 0 as \"any\", and the backend matches each independently.",
    auth: "any",
    permissions: ["read access on the target ownerAsiakasId"],
    args: [{ name: "betoniAsiakasId", type: "number", description: "Supplier scope (0 = any supplier)" }],
    flags: [
      { name: "owner", type: "number", description: "Owning tenant (ownerAsiakasId); default = your active company" },
    ],
    outputShape:
      "ListEnvelope<{ attrId, attrNimike, attrSelite, attrYksikkö, hinta, betoniAsiakasId, ownerAsiakasId, shared, isEnabled, showInDropDown, attrShortCuts, attrHelpId, entryTime, lastModifiedTime }>",
    prettyColumns: ["attrId", "attrNimike", "attrYksikkö", "hinta", "betoniAsiakasId", "ownerAsiakasId", "shared", "isEnabled"],
    errors: [
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --owner <asiakasId>, or `ib auth switch`" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
      { http: 403, exit: 3, meaning: "No read access to the requested ownerAsiakasId", remedy: "you may only read a tenant you have access to — check `ib auth whoami`" },
    ],
    notes: [
      "`shared` is true only when BOTH betoniAsiakasId AND ownerAsiakasId are 0. A row global on one axis is still scoped on the other, so a single 0 does not mean \"everyone sees it\".",
      "`hinta` is decimal(10,2) NULL — null means NO PRICE SET, which is distinct from 0.",
    ],
    seeAlso: ["ib betoni attr get"],
    examples: ["ib betoni attr list 0", "ib betoni attr list 8 --owner 1349"],
  },
  {
    command: "ib betoni attr get",
    aliases: ["ib betoni attr show"],
    description:
      "One concrete additive by attrId, scoped to an owning tenant (GET /api/betoni/attr/get/:attrId/:ownerAsiakasId). The route returns a recordset even for one row; this unwraps it.",
    auth: "any",
    permissions: ["read access on the target ownerAsiakasId"],
    args: [{ name: "attrId", type: "number", description: "attrId (the PK of betoniAttr)" }],
    flags: [
      { name: "owner", type: "number", description: "Owning tenant (ownerAsiakasId); default = your active company" },
    ],
    outputShape: "{ attrId, attrNimike, attrSelite, attrYksikkö, hinta, betoniAsiakasId, ownerAsiakasId, shared, isEnabled, showInDropDown, ... }",
    errors: [
      { origin: "client", exit: 5, match: "Attribute not found", meaning: "no such attribute for that owner", remedy: "the id may belong to ANOTHER tenant — the backend does not distinguish that from 'no such row'. Cross-check with `ib betoni attr list <betoniAsiakasId> --owner <id>`" },
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --owner <asiakasId>, or `ib auth switch`" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
      { http: 403, exit: 3, meaning: "No read access to the requested ownerAsiakasId", remedy: "check `ib auth whoami`" },
    ],
    seeAlso: ["ib betoni attr list"],
    examples: ["ib betoni attr get 12", "ib betoni attr get 12 --owner 1349"],
  },
  {
    command: "ib betoni reference",
    description:
      "The four fixed concrete lookup lists — raekoko (aggregate size), lujuus (strength), notkeus (consistency), kayttoika (working life) — in ONE call. These are the vocabularies a grade's laatuAllowedRae / laatuAllowedS / laatuAllowedC fields are expressed in.",
    auth: "none",
    flags: [
      { name: "kind", type: "string", description: "Return only one list", allowed: ["raekoko", "lujuus", "notkeus", "kayttoika"] },
    ],
    outputShape: "{ raekoko: [...], lujuus: [...], notkeus: [...], kayttoika: [...] } — narrowed to the single key when --kind is given",
    errors: [
      { origin: "client", exit: 4, match: "--kind must be one of", meaning: "unknown --kind value", remedy: "one of: raekoko, lujuus, notkeus, kayttoika" },
      { http: 500, exit: 6, meaning: "Backend error", remedy: "retry with --verbose" },
    ],
    notes: [
      "Bundled rather than split into four leaves because they are read together: decoding one grade's allowed-values fields needs all four vocabularies at once.",
      "These four routes are unauthenticated reference data, cached server-side with a 2-hour TTL.",
    ],
    seeAlso: ["ib betoni laatu list"],
    examples: ["ib betoni reference", "ib betoni reference --kind raekoko"],
  },
];
