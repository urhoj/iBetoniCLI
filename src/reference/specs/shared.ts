/**
 * Shared helpers and reusable spec fragments for the per-domain spec
 * segments (split from the monolithic specs.ts, fb#782). Everything here is
 * exported for the segment files; external consumers keep importing from the
 * `specs.ts` barrel, which re-exports the public surface.
 */
import type { CommandArg, CommandError, CommandFlag } from "../../output/help.js";
import { exitCodeFromStatus } from "../../api/errors.js";

/**
 * The empty-string CLEAR convention, carrying its PowerShell caveat.
 *
 * `clearHint` is the terse per-FLAG form; `clearNote` the sentence-level one for
 * a command description that explains the convention once. Helpers rather than
 * ~15 hand-copied sentences: the caveat existed on NONE of the sites when fb#634
 * was filed, and duplicated prose is precisely what drifts next time. Callers
 * concatenate rather than interpolate so the surrounding descriptions keep their
 * existing quoting (several contain backticks, which a template literal would
 * force us to escape). Long form: `ib help shell-quoting`.
 */
export const clearHint = (flag: string) =>
  `pass "" to clear — PowerShell DROPS a bare "", so use \`${flag}=\` there (same meaning in bash; \`ib help shell-quoting\`)`;

export const clearNote = (flag: string) =>
  `On Windows PowerShell a bare "" is DROPPED and the NEXT flag silently becomes the value — use the equals form \`${flag}=\` there, which means the same thing in bash (\`ib help shell-quoting\`).`;

/**
 * API error row: derive the exit code from the HTTP status.
 *
 * `match` (optional, ANY-of) narrows the row to ONE cause behind a status that
 * has several — `hintForError` prefers a matching row over the status's
 * catch-all (fb#485). List the narrow rows BEFORE the catch-all for readability;
 * order does not decide the winner, the substring hit does.
 */
export const apiErr = (
  http: number,
  meaning: string,
  remedy: string,
  match?: string | string[]
): CommandError => ({
  http,
  exit: exitCodeFromStatus(http),
  meaning,
  remedy,
  ...(match === undefined ? {} : { match }),
});

/**
 * The `--limit` parse-guard row: one uniform message, a per-command remedy.
 *
 * `cappedInt` validates through `intFlag`, so `--limit abc` / `0` / `5.5` now
 * fails locally at exit 4 on every call site (cl#1467) instead of travelling to
 * a backend that may or may not reject it. But an argParser throw resolves the
 * RUNNING command's own ERRORS row (fb#385), and 36 of the 42 `--limit` guards
 * had none — so the envelope carried the message with no `hint` (fb#697).
 *
 * Only `remedy` varies, because the message never does: `intFlag` emits exactly
 * `--limit must be an integer >= 1`. Name THIS command's cap and how to reach
 * rows beyond it — a cursor where one exists, the narrowing filters where none
 * does. That is the part a caller cannot derive from the message.
 *
 * Do NOT collapse this into `intFlag`'s third argument instead: a hint carried
 * on the ERROR overrides the command's spec row (see `src/targets.ts`), so one
 * blanket hint would shadow the six commands that already document a real
 * remedy — which is the regression fb#697 explicitly warns against.
 */
export const limitErr = (remedy: string): CommandError => ({
  origin: "client",
  exit: 4,
  match: "--limit",
  meaning: "--limit is not an integer >= 1, rejected locally before any request",
  remedy,
});

/**
 * The `--asiakas` parse-guard row, the cross-tenant scope flag's twin of
 * {@link limitErr}. Since fb#892 the person/vehicle `--asiakas` flags parse
 * through `intFlag`, so a non-numeric value fails locally at exit 4 with
 * exactly `--asiakas must be an integer >= 1` instead of reaching the wire as
 * the literal "NaN". An argParser throw resolves the RUNNING command's own
 * ERRORS row (fb#385), so every command that carries the guard documents this
 * row; the remedy never varies (unlike limitErr's per-command caps), hence a
 * constant.
 */
export const ASIAKAS_FLAG_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: "--asiakas",
  meaning: "--asiakas is not an integer >= 1, rejected locally before any request",
  remedy: "pass a positive asiakasId (a company id) — `ib company list` shows the ones you can reach",
};

/**
 * Sandwich the command-specific rows between the universal 401 and 500 rows,
 * preserving their order. Most specs' custom rows (403/404/…) belong BETWEEN
 * the two, which `...COMMON_AUTH_ERRORS` (a trailing spread) cannot express.
 */
export const authErrors = (...rows: CommandError[]): CommandError[] => [
  apiErr(401, "Token expired", "ib auth refresh"),
  ...rows,
  apiErr(500, "Backend error", "retry with --verbose"),
];

/**
 * Errors that apply to every authenticated command. Exported so
 * `ib reference dump` can hoist them into a single top-level `commonErrors`
 * block and strip the (identical) per-spec copies — they otherwise repeat
 * verbatim in ~240 specs and are the single largest field in the dump.
 */
export const COMMON_AUTH_ERRORS: CommandError[] = authErrors();

/** Errors that apply to every authenticated command with permission gating. */
export function permErrors(page: string): CommandError[] {
  return authErrors(apiErr(403, "Permission denied", `check ${page}`));
}

// ─── attachment shared fragments ─────────────────────────────────────────────
export const ATTACHMENT_ENTITY_FLAGS: CommandFlag[] = [
  { name: "keikka", type: "number", description: "Target keikkaId" },
  { name: "vehicle", type: "number", description: "Target vehicleId" },
  { name: "person", type: "number", description: "Target personId" },
  { name: "customer", type: "number", description: "Target asiakasId" },
  { name: "worksite", type: "number", description: "Target tyomaaId" },
  { name: "sijainti", type: "number", description: "Target sijaintiId" },
  { name: "tuote", type: "number", description: "Target tuoteId" },
  { name: "bug-report", type: "number", description: "Target bugReportId" },
  { name: "request", type: "number", description: "Jerry pumppuRequestId (request owner only)" },
  { name: "offer", type: "number", description: "Jerry pumppuOfferId (provider company only)" },
  { name: "message", type: "number", description: "Target messageId (chat message; attach = message author, read = thread participant)" },
];
export const ATTACHMENT_ROW =
  "{ attachmentId, origFileName, fileName, fileType, fileSize, fileComment, attachTime, liitaLaskuun, attachmentGroupId, attachmentGroupName, attachmentTypeId, attachmentTypeName, keikkaId?, vehicleId?, personId?, asiakasId?, tyomaaId?, sijaintiId?, tuoteId?, bugReportId?, pumppuRequestId?, pumppuOfferId?, messageId?, entryByPersonId, ownerAsiakasId, imageWidth, imageHeight }";
export const ENTITY_FLAG_NOTE =
  "Exactly ONE entity flag selects the target (--keikka | --vehicle | --person | --customer | --worksite | --sijainti | --tuote | --bug-report | --request | --offer | --message).";
export const DEPLOY_NOTE = "Deploy-gated (404 until the backend ships /api/cli/attachment/*).";

/** Appended to capped-list outputShapes — single-sources the wording + backend date. */
export const TRUNCATED_NOTE =
  " (+truncated:true when the result hit the limit; backend ≥ 2026-06-11)";

/** Appended to server-capped log outputShapes: the /api/changes routes return no
 *  cursor, so a FULL page is the only "there may be more" signal — the CLI flags
 *  it client-side, so it works against any backend (fb#375). */
export const LOG_CAPPED_NOTE =
  " (+truncated:true when the page filled --limit — cursor-less route, so a full page may hide older rows)";
/** Companion for log specs that also filter --field client-side (fb#375). */
export const LOG_FIELD_HINT_NOTE =
  " (+hint when --field filtered a capped page: the filter saw only the newest --limit rows)";

// ─── legal shared fragments ──────────────────────────────────────────────────
export const LEGAL_DEV_ERRORS: CommandError[] = [
  apiErr(401, "Token expired", "ib auth refresh"),
  apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
  apiErr(500, "Backend error", "retry with --verbose"),
];

// ─── vehicle cross-tenant (--asiakas) shared fragments ───────────────────────
// The --asiakas override on vehicle list/get/search reads another company's
// fleet; the extra permission line and 403 row are identical across all three
// specs, so single-source them here (see cliListKeyGen scopeParam + the
// hasVehicleAccessOnAsiakas gate in puminet5api).
export const VEHICLE_ASIAKAS_PERMISSION =
  "--asiakas: sysadmin/developer or a vehicle-manage role (admin/owner/vehicleHandler) on the target tenant";
// `match` narrows this row so the permErrors 403 alongside it stays structurally
// reachable (fb#668) — `matchHttpRow` falls back to the FIRST matchless row, so
// two matchless rows at one status make the second dead.
//
// Honest scope, corrected after review: on the four READ commands this is
// DEFENSIVE, not a bug that fired. `/api/cli/vehicle/{list,get,types,search}`
// are registered with `jwt` + cache middleware only, and the sole `sendForbidden`
// in vehicleCliRoutes.js is the cross-tenant one — so no plain permission 403
// exists there to be swallowed, and the permErrors row is unreachable either
// way. (The sijainti twin below is the case where the shadowing really did fire.)
// Substring is the backend's own text (vehicleCliRoutes.js:216/449/699).
export const VEHICLE_ASIAKAS_403: CommandError = apiErr(
  403,
  "No vehicle access on the requested --asiakas company",
  "use a tenant you have a vehicle-manage role on, or a developer token",
  "no vehicle access on the requested company"
);
/** Shared by every vehicle-row list (list/search/driver board/driver gaps) — they
 *  all read `dbo.vehicle`, so they all surface the legacy sentinel rows that no
 *  id-taking command will accept (fb#380). One constant so the four can't drift. */
export const VEHICLE_PLACEHOLDER_NOTE =
  "`placeholder: true` marks a legacy sentinel row (e.g. vehicleId 0 'Ei tietoa') that is listed but NOT addressable — `ib vehicle get 0` / `ib vehicle driver assign 0 …` exit 4. The key is absent on real vehicles. Which tenants carry one varies.";

/** Fleet ORDER is `sortNo`, which the rows carry but are not sorted by (fb#394):
 *  the list comes back in vehicleNo order, so a caller reproducing the grid's
 *  row order has to sort client-side — silently assuming the wire order IS the
 *  grid order is the failure this note exists to prevent. */
export const VEHICLE_ORDERING_NOTE =
  "Rows come back ordered by `vehicleNo` (then vehicleId), NOT by `sortNo` — the grid orders on `sortNo`, so sort client-side to reproduce its row order.";
/** `asiakasId` vs `ownerAsiakasId`: distinct columns, and only the first varies
 *  within one response (fb#394). */
export const VEHICLE_OWNER_NOTE =
  "`asiakasId` and `ownerAsiakasId` are distinct columns and often equal. `ownerAsiakasId` is the tenant this read is scoped to, so it is the SAME on every row of one response (the active company, or `--asiakas`); `asiakasId` is the assigned company and is what the grid splits own-vs-foreign vehicles on.";
/**
 * The isPublic admin gate's own words (fb#668).
 *
 * `sijainti update` and `set-public` each pair this row with a permErrors 403,
 * and `matchHttpRow` answers with the first MATCHLESS row at a status — so
 * without a `match` this one swallowed every 403 on both commands, including a
 * plain auth.page.sijainnit.edit denial. The substring is the backend's literal
 * Finnish text (modules/geocode/geocode.js `sendForbidden`); matching is
 * case-insensitive, so the lowercase form is fine.
 */
export const SIJAINTI_PUBLIC_403_MATCH = "vain yrityksen ylläpitäjä voi muuttaa sijainnin julkisuutta";

/**
 * `--geocode` fails CLIENT-side, before the write (fb#668 follow-up).
 *
 * These were documented as `http: 400`, which no path can produce:
 * `applyGeocodeToBody` resolves the address first and `failWith(..., 4)`s on no
 * match, so the request is never sent. Documented as HTTP they were dead by the
 * fb#280 rule AND shadowed the real "Validation failed" 400 — and because the
 * puomi row was the only matchless CLIENT row on `sijainti create`, a failed
 * geocode was actually answered with "pass metres 0–999.99 with min ≤ max".
 *
 * `status` varies (ZERO_RESULTS, NO_ROUTE_FOUND, …) so the match is on the
 * stable prefix the CLI itself writes, not on any one Google status.
 */
export const GEOCODE_CLIENT_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: "could not geocode address",
  meaning: "--geocode found no match for the address (Google returned ZERO_RESULTS or another non-OK status)",
  remedy: "supply a fuller --address, or pass --lat/--lng directly and drop --geocode",
};
/**
 * The `--puomi-min/--puomi-max` row, shared by `sijainti create|update|set-jerry`.
 *
 * All three mirror ONE guard (`assertPuomiFlags`), so the match array had three
 * maintenance sites for a single source — and had already drifted: set-jerry's
 * copy had lost the "(e.g. a typo …)" parenthetical the other two carry. `extra`
 * is the only genuine difference (update warns that a bad value would CLEAR the
 * stored bound).
 */
export const puomiErr = (extra = ""): CommandError => ({
  origin: "client",
  exit: 4,
  match: ["non-negative number of metres", "cannot exceed"],
  meaning: `--puomi-min/--puomi-max not a non-negative number (e.g. a typo Commander coerced to NaN) or min > max${extra}`,
  remedy: "pass metres 0–999.99 with min ≤ max",
});

export const GEOCODE_NO_ADDRESS_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: "--geocode requires --address",
  meaning: "--geocode passed with no address to resolve",
  remedy: "pass --address (or sijaintiOsoite1 in --body), or drop --geocode and give --lat/--lng",
};

// ─── person 404: say which DIMENSION failed (fb#620) ─────────────────────────
// `verify personId` is the wrong instruction most of the time this fires: the
// id is usually right and the SCOPE is wrong, because every person command is
// scoped to the active company. An agent that believes "this person does not
// exist" goes on to CREATE one — a duplicate row in a tenant that already had
// it. Naming both dimensions costs one line and removes that failure.
export const PERSON_SCOPE_404_REMEDY =
  "the id may be fine and the SCOPE wrong — these commands read the ACTIVE company only. Either the personId does not exist, or it belongs to another tenant: retry with `--asiakas <id>` (on `person get`), find them with `ib customer person list --asiakas <id>` or `ib person search --my-companies`, or switch lens with `ib company switch <id>`. Do NOT conclude the person does not exist and create a new one — that mints a duplicate.";
export const PERSON_SCOPE_NOTE =
  "Person reads are TENANT-SCOPED to your active company (plus global persons, ownerAsiakasId=null, and always yourself). A 404 therefore means 'not in this scope', not 'not in the database'.";

/** The list row is ~14 columns wide, so leftmost-fits would hide sortNo/ownership. */
export const VEHICLE_LIST_PRETTY_COLUMNS = [
  "vehicleId",
  "vehicleNo",
  "plate",
  "name",
  "typeName",
  "sortNo",
  "showInGrid",
  "asiakasId",
] as const;

/* The `ib vehicle driver` day-keyed leaves take their date EITHER positionally
 * or as `--date` (fb#393). The group used to be positional-only while its
 * `vehicle timeline`/`route`/`visits` siblings were flag-shaped, so an agent
 * arriving from one of those spent an exit 4 on argument shape alone. Three
 * constants, so the six leaves state the same contract. */
export const DRIVER_DATE_ARG: CommandArg = {
  name: "date",
  type: "date",
  required: false,
  description: "Day YYYY-MM-DD (or today/yesterday/tomorrow) — or pass it as --date",
};
export const DRIVER_DATE_FLAG: CommandFlag = {
  name: "date",
  type: "date",
  description: "Day YYYY-MM-DD (or today/yesterday/tomorrow) — alias for the <date> positional",
};
export const DRIVER_DATE_NOTE =
  "Give the day positionally OR as `--date` (the same flag `ib vehicle timeline` / `route` / `visits` take) — exactly one. Both together is fine only when they mean the same day; neither exits 4.";

// ─── cross-domain shared fragments ───────────────────────────────────────────
/** The system-admin 403 every `jerry admin` / admin-gated row repeats. */
export const SYSADMIN_403: CommandError = apiErr(403, "Not a system admin", "use a system-admin token");
/**
 * `resolveRoleTypeId` rejects an unknown --role LOCALLY, before any request, so
 * every role-taking command needs this client row alongside its backend-400 twin
 * (the 400 is still reachable — the backend enforces role limits too).
 */
export const ROLE_NAME_CLIENT_ERROR: CommandError = {
  origin: "client",
  exit: 4,
  match: ["unknown role", "names TWO different roles"],
  meaning: "unknown or ambiguous role name — rejected by the CLI before any request",
  remedy:
    "pass an exact role name; the error names your options and `ib person role explain <name>` describes one. \"tarjousAdmin\" is not a role name — it denotes TWO (fb#418)",
};
/** The dual-target `--asiakas` alias flag (see targets.ts addAsiakasTargetOption). */
export const ASIAKAS_TARGET_FLAG: CommandFlag = {
  name: "asiakas",
  type: "number",
  description: "Target asiakasId (alias for the positional)",
};
/** The write-safety `--reason` spelled REQUIRED (the v1.0.1 lifecycle rows). */
export const REASON_REQUIRED_FLAG: CommandFlag = {
  name: "reason",
  type: "string",
  description: "Audit-log reason (X-Action-Reason); REQUIRED",
};
/** The standard list `--limit`: default 100, server cap 500. */
export const LIMIT_500_FLAG: CommandFlag = {
  name: "limit",
  type: "number",
  default: "100",
  description: "Max rows (capped at 500)",
};
/** Cross-tenant `--owner` list scope, validated client-side. */
export const OWNER_ASIAKAS_FLAG: CommandFlag = {
  name: "owner",
  type: "number",
  description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)",
};
/** The `--search` alias every `<query>`-positional search command offers. */
export const SEARCH_ALIAS_FLAG: CommandFlag = {
  name: "search",
  type: "string",
  description: "Search query (alias for the <query> positional)",
};
/** The two safety notes every combinator `merge` spec states verbatim. */
export const MERGE_DRY_RUN_FIRST_NOTE =
  "ALWAYS --dry-run first: the /merge route has no X-Dry-Run guard, so a real invocation merges immediately.";
export const MERGE_VALIDATE_READONLY_NOTE =
  "--dry-run issues a read-only POST to /validate (tagged `read`), so it runs even under --read-only / IB_READ_ONLY; only a real merge is blocked by the write-lock.";
