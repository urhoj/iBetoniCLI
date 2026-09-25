// foreign-key specs (fb#1683) — the `ib person fk` / `ib customer fk` /
// `ib vehicle fk` subgroups. Three exports so the barrel (src/reference/specs.ts)
// can spread each one right after its domain's segment; order within each list
// is load-bearing (catalogue order drives sibling-suggestion ranking and the
// parse-guard-hint snapshots).
import type { CommandArg, CommandError, CommandFlag, CommandSpec } from "../../output/help.js";
import { ASIAKAS_TARGET_ERR, ASIAKAS_TARGET_FLAG, COMMON_AUTH_ERRORS, OWNER_ASIAKAS_FLAG, PERSON_SCOPE_404_REMEDY, apiErr, intParseErr } from "./shared.js";

const SOURCE_FLAG: CommandFlag = {
  name: "source",
  type: "string",
  description: "foreignKeySources row, by NAME (case-insensitive) or numeric id — `fk sources` lists them",
  required: true,
};
const KEY_FLAG: CommandFlag = { name: "key", type: "string", description: "The foreign key value (external id / nickname); trimmed", required: true };

const OWNER_PARSE_ERR = intParseErr("--owner", "pass a positive ownerAsiakasId, or omit it to use the active company");
const OWNER_UNRESOLVED_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: "could not resolve active company",
  meaning: "No --owner given and the token carries no active company",
  remedy: "pass --owner <id>, or run `ib auth switch <asiakasId>`",
};
const SOURCE_UNKNOWN_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: "unknown foreign-key source",
  meaning: "--source names no row in the owner's source list (the message lists the valid names + ids)",
  remedy: "pick one of the listed names, or check `--owner` — sources are per tenant (plus the global ones)",
};
const idParseErr = (name: string): CommandError => ({
  origin: "client",
  exit: 4,
  match: `invalid ${name}`,
  meaning: `<${name}> is not a positive integer`,
  remedy: `pass a numeric ${name}`,
});
const PERSON_ARG: CommandArg = { name: "person", type: "string", description: "personId or a name resolved within your active company" };
const NO_PERSON_ERR: CommandError = { origin: "client", exit: 5, match: "No person matches", meaning: "The <person> name resolved to nobody in your active company", remedy: PERSON_SCOPE_404_REMEDY };
const VEHICLE_ID_ARG: CommandArg = { name: "vehicleId", type: "number", description: "vehicle id" };
const VEHICLE_ID_ERR = idParseErr("vehicleId");
const ASIAKAS_ID_ARG: CommandArg = { name: "asiakasId", type: "number", required: false, description: "customer id — or pass --asiakas" };
const READ_403 = apiErr(403, "No read access to the owner tenant", "you must belong to --owner's company (or hold a view role there); sysadmin/developer bypass");
const EDIT_403 = apiErr(403, "No edit role on the owner tenant", "requires an edit-tier company role on --owner (asiakasAdmin / the entity's handler role); sysadmin bypass");
const OWNER_NOTE =
  "`--owner` is the tenant the keys belong to (default: the active company). Betomik order-book driver nicknames live on `--owner 27 --source betomik-orderbook`.";
const ACTIONS_NOTE = "Write results carry `action`: inserted | updated | unchanged (no request sent) | removed.";
/** person fk only (fb#1732): the rest of `ib person` spells the tenant scope --asiakas. */
const PERSON_OWNER_ALIAS_NOTE =
  "`--asiakas <id>` is accepted as a hidden alias of `--owner` (the rest of `ib person` spells the tenant scope that way); passing both with different values exits 4.";

const sourcesSpec = (group: "person" | "customer" | "vehicle"): CommandSpec => ({
  command: `ib ${group} fk sources`,
  description:
    "List the foreign-key SOURCES (dbo.foreignKeySources) usable on --source for this owner: the tenant's own rows plus the global ones. Same list for person/customer/vehicle keys.",
  permissions: ["membership of the owner tenant"],
  flags: [OWNER_ASIAKAS_FLAG],
  outputShape: "ListEnvelope<{ foreignKeySourceId, name, column, ownerAsiakasId }>",
  errors: [OWNER_PARSE_ERR, OWNER_UNRESOLVED_ERR, READ_403, ...COMMON_AUTH_ERRORS],
  examples: [`ib ${group} fk sources`, `ib ${group} fk sources --owner 27`],
});

export const PERSON_FK_SPECS: CommandSpec[] = [
  sourcesSpec("person"),
  {
    command: "ib person fk list",
    description:
      "List a person's foreign keys (dbo.personForeignKeys) for one owner tenant — every external id / nickname per source, with the source NAME resolved. Many keys per source are allowed (one row per nickname).",
    permissions: ["membership of the owner tenant (read)"],
    args: [PERSON_ARG],
    flags: [OWNER_ASIAKAS_FLAG],
    outputShape: "ListEnvelope<{ personForeignKeyId, key, source, sourceId, text, isDisabled, entryTime }> (`source` null when the id is not in the owner's source list)",
    errors: [
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      NO_PERSON_ERR,
      READ_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [OWNER_NOTE, PERSON_OWNER_ALIAS_NOTE],
    seeAlso: ["ib person fk set", "ib person fk sources", "ib person fk list-source"],
    examples: ["ib person fk list 6354 --owner 27", "ib person fk list 'Matti Virtanen'"],
  },
  {
    command: "ib person fk list-source",
    description:
      "List EVERY taught foreign key of one source for an owner, across ALL persons (fb#1740) — the aggregate counterpart to `fk list`, which is scoped to one person. Reviewing a whole source's taught vocabulary (e.g. every betomik-orderbook driver nickname under an owner) otherwise required a raw dbo query.",
    permissions: ["membership of the owner tenant (read)"],
    args: [{ name: "source", type: "string", description: "foreignKeySources row, by NAME (case-insensitive) or numeric id — `fk sources` lists them" }],
    flags: [OWNER_ASIAKAS_FLAG],
    outputShape: "ListEnvelope<{ personForeignKeyId, personId, name, key, text, isDisabled, entryTime }>",
    errors: [
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      SOURCE_UNKNOWN_ERR,
      READ_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [OWNER_NOTE, PERSON_OWNER_ALIAS_NOTE, "The person column is `name` (first + last), the canonical person vocabulary of every CLI list (fb#692); it was `personName` before 2026-09-25."],
    seeAlso: ["ib person fk list", "ib person fk sources"],
    examples: ["ib person fk list-source betomik-orderbook --owner 27", "ib person fk list-source 6 --owner 27"],
  },
  {
    command: "ib person fk set",
    description:
      "Add or update ONE foreign key on a person: --source + --key. Reads the existing rows first and matches on source + key (trimmed, case-insensitive — the same rule the Betomik driver matcher applies), so re-running never duplicates: a match with the same --text/--disabled is `unchanged` and sends nothing; a different label/flag updates that row by id; no match inserts. --dry-run resolves client-side (the route has no server dry-run) and returns the plan.",
    permissions: ["edit-tier company role on the owner tenant"],
    args: [PERSON_ARG],
    flags: [
      SOURCE_FLAG,
      KEY_FLAG,
      { name: "text", type: "string", description: "Free label stored in foreignKeyText (omit = keep the stored one on update)" },
      { name: "disabled", type: "boolean", description: "Store the row disabled (ignored by matchers); omit = enabled" },
      OWNER_ASIAKAS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ personId, ownerAsiakasId, source, sourceId, key, action: inserted|updated|unchanged, personForeignKeyId } (id null after an insert — the proc returns none) · dry-run: { dryRun:true, would:{ …same } }",
    errors: [
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      SOURCE_UNKNOWN_ERR,
      NO_PERSON_ERR,
      apiErr(400, "Invalid personId / ownerAsiakasId", "pass positive integers"),
      EDIT_403,
      apiErr(409, "The row to update vanished between read and write", "re-run — the next pass inserts"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [OWNER_NOTE, PERSON_OWNER_ALIAS_NOTE, ACTIONS_NOTE, "Betomik nicknames: matching is case-insensitive and only `isDisabled:false` rows count, so `--disabled` parks a nickname without deleting it."],
    seeAlso: ["ib person fk import", "ib person fk list", "ib person fk remove"],
    examples: [
      "ib person fk set 6354 --source betomik-orderbook --key Tomppa --owner 27 --reason 'T5 nicknames'",
      "ib person fk set 6354 --source betomik-orderbook --key Tomppa --owner 27 --dry-run",
      "ib person fk set 6354 --source 42 --key Tomppa --text 'sheet spelling' --disabled --owner 27",
    ],
  },
  {
    command: "ib person fk remove",
    description:
      "Delete ONE foreign key row by personForeignKeyId. The id must be on that person for that owner (checked client-side first — the backend delete is by id only), otherwise exit 5 and nothing is sent. --dry-run resolves client-side.",
    permissions: ["edit-tier company role on the owner tenant"],
    args: [
      PERSON_ARG,
      { name: "personForeignKeyId", type: "number", description: "row id from `ib person fk list`" },
    ],
    flags: [OWNER_ASIAKAS_FLAG],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ action:'removed', personId, ownerAsiakasId, personForeignKeyId, key, source, sourceId } · dry-run: { dryRun:true, would:{ …same } }",
    errors: [
      idParseErr("personForeignKeyId"),
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      { origin: "client", exit: 5, match: "is not on person", meaning: "That personForeignKeyId is not among this person's rows for this owner", remedy: "`ib person fk list <person> --owner <id>` shows the ids" },
      NO_PERSON_ERR,
      EDIT_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [PERSON_OWNER_ALIAS_NOTE],
    seeAlso: ["ib person fk list"],
    examples: ["ib person fk remove 6354 900 --owner 27 --reason 'typo'", "ib person fk remove 6354 900 --owner 27 --dry-run"],
  },
  {
    command: "ib person fk import",
    description:
      "Batch `set` from a JSON array — the one-pass load for a driver nickname list. Rows: { personId, key, source?, text?, disabled? }; `source` per row or the --source default; numeric personId only (no batch name resolution). In-file duplicates (same person + source + key) are settled first: an identical repeat reads `unchanged`, one with a different text/disabled fails its own row. Then ONE read per person and each row planned like `set` (inserted / updated / unchanged). Rows missing personId/key/source are reported failed without a request; a failing write fails only its own row. --dry-run plans everything and sends nothing. Exit 0 even with failures — read `failed`.",
    permissions: ["edit-tier company role on the owner tenant"],
    args: [{ name: "file", type: "string", description: "JSON array file, or - for stdin (argv-safe for ä/ö)" }],
    flags: [
      { name: "source", type: "string", description: "Default source (name or id) for rows without their own `source`" },
      OWNER_ASIAKAS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ dryRun?, results:[{ personId, key, ok, action?, error? }] (input order), ok, failed, inserted, updated, unchanged }",
    errors: [
      { origin: "client", exit: 4, match: "import:", meaning: "File is not valid JSON, or its root is not an array", remedy: "pass a JSON array of { personId, key, source?, text?, disabled? } (or - for stdin)" },
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      SOURCE_UNKNOWN_ERR,
      EDIT_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [OWNER_NOTE, PERSON_OWNER_ALIAS_NOTE, "Per-row source errors are reported in `results`, not thrown; an unknown --source DEFAULT exits 4 before any request."],
    seeAlso: ["ib person fk set", "ib dev betomik-orderbook sync"],
    examples: [
      "ib person fk import nicknames.json --source betomik-orderbook --owner 27 --reason 'T5 list'",
      "echo '[{\"personId\":6354,\"key\":\"Tomppa\"},{\"personId\":6354,\"key\":\"Toomas\"}]' | ib person fk import - --source betomik-orderbook --owner 27 --dry-run",
    ],
  },
];

export const CUSTOMER_FK_SPECS: CommandSpec[] = [
  sourcesSpec("customer"),
  {
    command: "ib customer fk list",
    description:
      "List a customer's foreign keys (dbo.asiakasForeignKeys) for one owner tenant — the external id per source (e.g. an accounting-system customer number). One key per source.",
    permissions: ["membership of the owner tenant (read)"],
    args: [ASIAKAS_ID_ARG],
    flags: [ASIAKAS_TARGET_FLAG, OWNER_ASIAKAS_FLAG],
    outputShape: "ListEnvelope<{ asiakasForeignKeyId, key, source, sourceId, entryTime }>",
    errors: [ASIAKAS_TARGET_ERR, OWNER_PARSE_ERR, OWNER_UNRESOLVED_ERR, READ_403, ...COMMON_AUTH_ERRORS],
    notes: [OWNER_NOTE],
    seeAlso: ["ib customer fk set", "ib customer fk sources"],
    examples: ["ib customer fk list 1234", "ib customer fk list --asiakas 1234 --owner 8"],
  },
  {
    command: "ib customer fk set",
    description:
      "Set a customer's foreign key on one source (server upsert keyed by customer + source + owner). The existing rows are read first so the result names the action and an identical key sends nothing. --dry-run resolves client-side (the route has no server dry-run).",
    permissions: ["edit-tier company role on the owner tenant"],
    args: [ASIAKAS_ID_ARG],
    flags: [ASIAKAS_TARGET_FLAG, SOURCE_FLAG, KEY_FLAG, OWNER_ASIAKAS_FLAG],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ asiakasId, ownerAsiakasId, source, sourceId, key, action: inserted|updated|unchanged } · dry-run: { dryRun:true, would:{ …same } }",
    errors: [
      ASIAKAS_TARGET_ERR,
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      SOURCE_UNKNOWN_ERR,
      { origin: "client", exit: 6, match: "customer foreign key write failed", meaning: "The backend answered 200 with { success:false } — usually the UNIQUE (foreignKey, owner) index: that key already belongs to another customer of this owner", remedy: "find the holder with `ib customer fk list <other> --owner <id>` and remove it, or use a different key" },
      apiErr(400, "Missing asiakasId / source / key / owner", "pass all four"),
      EDIT_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [OWNER_NOTE, ACTIONS_NOTE, "foreignKey is nvarchar(50)."],
    seeAlso: ["ib customer fk list", "ib customer fk remove"],
    examples: ["ib customer fk set 1234 --source fennoa --key F-1001 --reason 'accounting link'", "ib customer fk set 1234 --source fennoa --key F-1001 --dry-run"],
  },
  {
    command: "ib customer fk remove",
    description:
      "Delete ONE customer foreign-key row by asiakasForeignKeyId. The id must be on that customer for that owner (checked client-side; the backend delete is also owner-scoped), otherwise exit 5 and nothing is sent. --dry-run resolves client-side.",
    permissions: ["edit-tier company role on the owner tenant"],
    args: [
      { name: "asiakasId", type: "number", description: "customer id" },
      { name: "asiakasForeignKeyId", type: "number", description: "row id from `ib customer fk list`" },
    ],
    flags: [OWNER_ASIAKAS_FLAG],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ action:'removed', asiakasId, ownerAsiakasId, asiakasForeignKeyId, key, source, sourceId } · dry-run: { dryRun:true, would:{ …same } }",
    errors: [
      idParseErr("asiakasId"),
      idParseErr("asiakasForeignKeyId"),
      OWNER_PARSE_ERR,
      OWNER_UNRESOLVED_ERR,
      { origin: "client", exit: 5, match: "is not on customer", meaning: "That asiakasForeignKeyId is not among this customer's rows for this owner", remedy: "`ib customer fk list <asiakasId> --owner <id>` shows the ids" },
      apiErr(404, "Row not found for this owner (deleted meanwhile)", "re-list"),
      EDIT_403,
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib customer fk list"],
    examples: ["ib customer fk remove 1234 55 --reason 'wrong number'", "ib customer fk remove 1234 55 --owner 8 --dry-run"],
  },
];

const VEHICLE_OWNER_NOTE =
  "Vehicle keys carry no owner column — the tenant gate is the VEHICLE's owner, server-side. `--owner` only picks whose source list `--source` resolves against (default: the active company).";

export const VEHICLE_FK_SPECS: CommandSpec[] = [
  sourcesSpec("vehicle"),
  {
    command: "ib vehicle fk get",
    description: "Read a vehicle's foreign key on ONE source (dbo.vehicleForeignKeys — e.g. the GPS provider's unit id). One key per source; `key` null when unset.",
    permissions: ["read access to the vehicle's owner tenant"],
    args: [VEHICLE_ID_ARG],
    flags: [SOURCE_FLAG, OWNER_ASIAKAS_FLAG],
    outputShape: "{ vehicleId, source, sourceId, key: string|null }",
    errors: [VEHICLE_ID_ERR, OWNER_PARSE_ERR, OWNER_UNRESOLVED_ERR, SOURCE_UNKNOWN_ERR, READ_403, ...COMMON_AUTH_ERRORS],
    notes: [VEHICLE_OWNER_NOTE],
    seeAlso: ["ib vehicle fk list", "ib vehicle fk set"],
    examples: ["ib vehicle fk get 135 --source mapon", "ib vehicle fk get 135 --source ecofleet --owner 27"],
  },
  {
    command: "ib vehicle fk list",
    description: "All foreign keys on a vehicle: the backend has no list route, so this reads the owner's source list and fetches each source in parallel, keeping the ones that are set.",
    permissions: ["read access to the vehicle's owner tenant"],
    args: [VEHICLE_ID_ARG],
    flags: [OWNER_ASIAKAS_FLAG],
    outputShape: "ListEnvelope<{ vehicleId, key, source, sourceId }>",
    errors: [VEHICLE_ID_ERR, OWNER_PARSE_ERR, OWNER_UNRESOLVED_ERR, READ_403, ...COMMON_AUTH_ERRORS],
    notes: [VEHICLE_OWNER_NOTE, "One GET per source of the owner (~10); a source missing from `--owner`'s list is not probed."],
    seeAlso: ["ib vehicle fk get", "ib vehicle fk sources"],
    examples: ["ib vehicle fk list 135", "ib vehicle fk list 135 --owner 27"],
  },
  {
    command: "ib vehicle fk set",
    description:
      "Set a vehicle's foreign key on one source (replaces the previous value — one key per source). An identical key is `unchanged` and sends nothing. --dry-run is SERVER-side: the route honours X-Dry-Run and echoes the would-be row without writing.",
    permissions: ["edit-tier role on the vehicle's owner tenant (vehicleHandler / asiakasAdmin)"],
    args: [VEHICLE_ID_ARG],
    flags: [SOURCE_FLAG, KEY_FLAG, OWNER_ASIAKAS_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ vehicleId, source, sourceId, key, action: inserted|updated|unchanged } · dry-run: { dryRun:true, would:{ …same }, server:{ dryRun:true, wouldUpdate } }",
    errors: [VEHICLE_ID_ERR, OWNER_PARSE_ERR, OWNER_UNRESOLVED_ERR, SOURCE_UNKNOWN_ERR, EDIT_403, ...COMMON_AUTH_ERRORS],
    notes: [VEHICLE_OWNER_NOTE, ACTIONS_NOTE],
    seeAlso: ["ib vehicle fk get", "ib vehicle fk remove"],
    examples: ["ib vehicle fk set 135 --source mapon --key 12345 --reason 'GPS unit installed'", "ib vehicle fk set 135 --source mapon --key 12345 --dry-run"],
  },
  {
    command: "ib vehicle fk remove",
    description:
      "Clear a vehicle's foreign key on one source. Sends the backend's delete form (an empty key on `/foreignKeys/set`); when nothing is set the result is `unchanged` and nothing is sent. --dry-run is SERVER-side (echoes `wouldUpdate` with the empty key).",
    permissions: ["edit-tier role on the vehicle's owner tenant (vehicleHandler / asiakasAdmin)"],
    args: [VEHICLE_ID_ARG],
    flags: [SOURCE_FLAG, OWNER_ASIAKAS_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ vehicleId, source, sourceId, key (the value removed), action: removed|unchanged } · dry-run: { dryRun:true, would:{ …same }, server }",
    errors: [VEHICLE_ID_ERR, OWNER_PARSE_ERR, OWNER_UNRESOLVED_ERR, SOURCE_UNKNOWN_ERR, EDIT_403, ...COMMON_AUTH_ERRORS],
    notes: [VEHICLE_OWNER_NOTE],
    seeAlso: ["ib vehicle fk get", "ib vehicle fk set"],
    examples: ["ib vehicle fk remove 135 --source mapon --reason 'unit moved'", "ib vehicle fk remove 135 --source mapon --dry-run"],
  },
];
