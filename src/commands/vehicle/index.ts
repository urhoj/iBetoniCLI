import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveDate, todayHelsinki } from "../../dates.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { parseId, intFlag, resolveSearchQuery, cappedInt, assertEnum, queryAliasOption } from "../../targets.js";
import { diffFields } from "../../diff.js";
import { registerVehicleDriverCommands } from "./driver.js";
import { markPlaceholderVehicles } from "./placeholder.js";
import { registerLogAlias } from "../log/index.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";

/**
 * Parse a CLI boolean flag value. Accepts true/1/yes/on (case-insensitive) as
 * true; everything else is false. Used by `--show-in-grid <bool>`.
 */
function parseBoolFlag(s: string): boolean {
  return /^(true|1|yes|on)$/i.test(s.trim());
}

export interface VehicleListFilter {
  limit?: number;
  cursor?: string;
  /** Include soft-deleted vehicles (default: excluded). */
  deleted?: boolean;
  /** Only vehicles with showInGrid = 1. */
  gridOnly?: boolean;
  /** Only vehicles whose validity window covers this YYYY-MM-DD. */
  validOn?: string;
  /** Only vehicles of this vehicleTypeId. */
  type?: number;
  /**
   * Read another company's fleet (cross-tenant). Requires sysadmin/developer, or
   * an admin/owner/vehicleHandler role on the target tenant (same gate as
   * `vehicle create`/`update`); default = the active company from the JWT.
   */
  asiakas?: number;
}

export interface VehicleDayFilter {
  date?: string;
}

export interface VehicleVisitsFilter {
  days?: number;
  /** Only visits on this day (resolved YYYY-MM-DD), Europe/Helsinki. */
  date?: string;
}

/** List envelope returned by the GPS/telemetry vehicle reads (locations/timeline/route/visits), plus the gpsAvailable flag. */
type GpsListEnvelope = ListEnvelope<Record<string, unknown>> & { gpsAvailable: boolean };

const VISIT_FILTER_TYPES = ["tyomaa", "sijainti"] as const;

const VISIT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/cli/vehicle/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`. Rows are
 * self-describing — each carries showInGrid / firstDate / lastDate /
 * deletedTime alongside { vehicleId, vehicleNo, plate, name, type, typeName,
 * capacity, sortNo, asiakasId, ownerAsiakasId } (name ← vehicleNimi, typeName ←
 * vehicleTypes.vehicleTypeName, null when unset). `sortNo` is the grid's ORDER
 * and `asiakasId`/`ownerAsiakasId` its GROUPING, so fleet layout is answerable
 * from one call (fb#394) — note the rows themselves arrive in vehicleNo order,
 * not sortNo order. Default scope is
 * non-deleted with no narrowing (grid-hidden AND expired rows ARE included);
 * `deleted` / `gridOnly` / `validOn` / `type` opt into narrowing. Legacy
 * sentinel rows carry `placeholder: true` — see `./placeholder.ts`.
 */
export async function runVehicleList(
  client: ApiClient,
  opts: VehicleListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  return markPlaceholderVehicles(
    await client.get<ListEnvelope<Record<string, unknown>>>(
      `/api/cli/vehicle/list${qs({
        limit: opts.limit,
        cursor: opts.cursor || undefined,
        // `1`, not the raw boolean — `qs` would serialise `true` as "true".
        deleted: opts.deleted ? 1 : undefined,
        gridOnly: opts.gridOnly ? 1 : undefined,
        validOn: opts.validOn || undefined,
        type: opts.type,
        asiakas: opts.asiakas,
      })}`
    )
  );
}

/**
 * GET /api/cli/vehicle/get/:vehicleId. Returns the full flat "Perustiedot"
 * record: identity (vehicleNo/name/plate/type/typeName), specs (boomLength ←
 * vehiclePuomi, capacity ← vehicleM3, sortNo), validity (firstDate/lastDate),
 * memo, billingProductId, asiakasId, ownerAsiakasId, defaultDriverId, and the
 * behaviour toggles (showInGrid/showInReports/useNoDriverBar/isRestricted/
 * hasGpsTracking).
 *
 * `asiakas` reads a vehicle owned by another company (cross-tenant); it needs
 * sysadmin/developer or a vehicle-manage role on that tenant, else the backend
 * returns 403. Default = the active company from the JWT.
 */
export async function runVehicleGet(
  client: ApiClient,
  vehicleId: number,
  asiakas?: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/vehicle/get/${vehicleId}${qs({ asiakas })}`
  );
}

/**
 * GET /api/cli/vehicle/status/:vehicleId. Returns the flat status record:
 * current driver, current keikka, and latest GPS ping (or null fields).
 */
export async function runVehicleStatus(
  client: ApiClient,
  vehicleId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/vehicle/status/${vehicleId}`
  );
}

/**
 * GET /api/cli/vehicle/locations — fleet-wide live position snapshot.
 *
 * Rows are self-describing about how far they can be trusted (feedback #324):
 * `matched` is false when the Ecofleet object's plate resolves to no
 * dbo.vehicle row (vehicleId:null — expected, not an error), and
 * `ageMinutes`/`stale` report tracker freshness against the envelope's
 * `staleAfterMinutes`. Pass-through: the backend derives both.
 */
export async function runVehicleLocations(
  client: ApiClient
): Promise<GpsListEnvelope> {
  return client.get<GpsListEnvelope>(
    "/api/cli/vehicle/locations"
  );
}

/** One per-day GPS read; the two exported leaves differ only in the path segment. */
const gpsDayRead =
  (kind: "timeline" | "route") =>
  (client: ApiClient, vehicleId: number, opts: VehicleDayFilter): Promise<GpsListEnvelope> =>
    client.get<GpsListEnvelope>(
      `/api/cli/vehicle/${kind}/${vehicleId}${qs({ date: opts.date || undefined })}`
    );

/** GET /api/cli/vehicle/timeline/:vehicleId?date= — per-day stop/travel segments. */
export const runVehicleTimeline = gpsDayRead("timeline");

/** GET /api/cli/vehicle/route/:vehicleId?date= — per-day ordered GPS polyline. */
export const runVehicleRoute = gpsDayRead("route");

/**
 * GET /api/cli/vehicle/visits/:filterType/:filterId?days= — vehicles that
 * visited a site. `opts.date` filters the visits to one Europe/Helsinki day
 * CLIENT-side (the backend only supports a days look-back); when `date` is
 * given without `days`, the look-back is derived to just cover that day so
 * the server doesn't scan all-time.
 */
export async function runVehicleVisits(
  client: ApiClient,
  filterType: string,
  filterId: number,
  opts: VehicleVisitsFilter
): Promise<GpsListEnvelope> {
  assertEnum(filterType, VISIT_FILTER_TYPES, "filterType");
  let days = opts.days;
  if (opts.date !== undefined) {
    if (!VISIT_DATE_RE.test(opts.date)) {
      failWith("date must be YYYY-MM-DD (or today/yesterday/tomorrow)", 4);
    }
    if (days === undefined) {
      // +2 covers the UTC↔Helsinki offset and the partial current day.
      days = Math.max(1, Math.ceil((Date.now() - Date.parse(opts.date)) / 86_400_000) + 2);
    }
  }
  const env = await client.get<GpsListEnvelope>(
    `/api/cli/vehicle/visits/${filterType}/${filterId}${qs({ days })}`
  );
  if (opts.date === undefined) return env;
  const items = (env.items || []).filter((v) => {
    const arrived = typeof v.arrived === "string" ? todayHelsinki(new Date(v.arrived)) : null;
    const departed = typeof v.departed === "string" ? todayHelsinki(new Date(v.departed)) : null;
    // A visit spanning midnight matches on either end.
    return arrived === opts.date || departed === opts.date;
  });
  return { ...env, items, count: items.length };
}

/**
 * GET /api/cli/vehicle/types — list selectable vehicle types
 * (vehicleTypeId + name) for the active company, in the list envelope shape.
 *
 * `asiakas` reads another company's type list (cross-tenant) — needed when
 * creating a vehicle under that tenant (`vehicle create --asiakas`), since types
 * are tenant-defined. Same gate as `vehicle list --asiakas`; default = active
 * company from the JWT.
 */
export async function runVehicleTypes(
  client: ApiClient,
  asiakas?: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/types${qs({ asiakas })}`
  );
}

/**
 * GET /api/cli/vehicle/list?search=…&limit=… — substring search over the
 * vehicle list (reg-no / name / fleet number). Reuses the list endpoint with a
 * `search` query param; `limit` is appended only when supplied.
 */
export async function runVehicleSearch(
  client: ApiClient,
  query: string,
  limit?: number,
  asiakas?: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  // Same endpoint as `list`, so the same legacy sentinel rows can come back
  // (a search for "ei" matches "Ei tietoa") — stamp them identically.
  return markPlaceholderVehicles(
    await client.get<ListEnvelope<Record<string, unknown>>>(
      `/api/cli/vehicle/list${qs({ search: query, limit, asiakas })}`
    )
  );
}

/**
 * GET /api/cli/vehicle/dates/:vehicleId — a vehicle's inspection/cert dates
 * (e.g. katsastus, vakuutus) in the list envelope shape.
 */
export async function runVehicleDatesList(
  client: ApiClient,
  vehicleId: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/dates/${vehicleId}`
  );
}

/**
 * GET /api/cli/vehicle/dates/expiring — inspection/cert dates expiring within
 * the next `days` window across the whole fleet. `days` is appended as a query
 * param only when supplied (backend default applies otherwise, typically 30).
 */
export async function runVehicleDatesExpiring(
  client: ApiClient,
  days?: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/dates/expiring${qs({ days })}`
  );
}

/**
 * The writable subset of a vehicle row. Every field is optional so the same
 * shape backs both create (unspecified → null) and update (unspecified → keep
 * current value via read-merge-write).
 */
export interface VehicleWriteFields {
  vehicleRegNo?: string;
  vehicleNimi?: string;
  vehicleNo?: number;
  vehicleTypeId?: number;
  memo?: string;
  defaultKuski_personId?: number;
  vehicleM3?: number;
  /** Boom length in metres (a core BetoniJerry matching field). */
  vehiclePuomi?: number;
  asiakasId?: number;
  showInGrid?: boolean;
  firstDate?: string;
  lastDate?: string;
}

/**
 * Writable columns compared for the `vehicle update --dry-run` field-level diff.
 * Read-only / system columns (sortNo, isRestricted, visibility, etc.) are
 * intentionally excluded — they are carried through unchanged and are not
 * settable from the CLI.
 */
/** Parse `<n>` as a number — the coercion every numeric vehicle flag uses. */
const asNumber = (s: string): number => Number(s);

/**
 * The writable vehicle columns as ONE table: flag spelling, help text, and the
 * `VehicleWriteFields` key each maps to. `create` and `update` expose
 * overlapping-but-different subsets of it (and word two flags differently), so
 * the table carries a `modes` list and an optional per-mode description rather
 * than each command re-listing the columns.
 *
 * ORDER IS THE HELP OUTPUT — filtering this list by mode reproduces exactly the
 * option order each command declares.
 */
const VEHICLE_FIELDS: ReadonlyArray<{
  flag: string;
  /** One string, or per-mode text when the two commands word it differently. */
  description: string | { create: string; update: string };
  /** Commander's camelCased option key. */
  optKey: string;
  /** Target key in {@link VehicleWriteFields}. */
  field: keyof VehicleWriteFields;
  parse?: (s: string) => number | boolean;
  modes: ReadonlyArray<"create" | "update">;
}> = [
  { flag: "--reg <s>", description: "Registration number (vehicleRegNo)", optKey: "reg", field: "vehicleRegNo", modes: ["create", "update"] },
  { flag: "--name <s>", description: "Display name (vehicleNimi)", optKey: "name", field: "vehicleNimi", modes: ["create", "update"] },
  { flag: "--no <n>", description: "Fleet number (vehicleNo)", optKey: "no", field: "vehicleNo", parse: asNumber, modes: ["create", "update"] },
  {
    flag: "--type <n>",
    description: { create: "vehicleTypeId (see `ib vehicle types`)", update: "vehicleTypeId" },
    optKey: "type",
    field: "vehicleTypeId",
    parse: asNumber,
    modes: ["create", "update"],
  },
  { flag: "--memo <s>", description: "Free-text memo", optKey: "memo", field: "memo", modes: ["create", "update"] },
  { flag: "--default-driver <pid>", description: "Default driver personId", optKey: "defaultDriver", field: "defaultKuski_personId", parse: asNumber, modes: ["create"] },
  { flag: "--capacity <m3>", description: "Concrete capacity in m3 (vehicleM3)", optKey: "capacity", field: "vehicleM3", parse: asNumber, modes: ["create", "update"] },
  {
    flag: "--puomi <m>",
    description: "Boom length in metres (vehiclePuomi — BetoniJerry matching field)",
    optKey: "puomi",
    field: "vehiclePuomi",
    parse: asNumber,
    modes: ["create", "update"],
  },
  {
    flag: "--asiakas <id>",
    description: {
      create: "Owning asiakasId (defaults to active company; needs a vehicle-manage role on that tenant)",
      update: "Owning asiakasId",
    },
    optKey: "asiakas",
    field: "asiakasId",
    parse: asNumber,
    modes: ["create", "update"],
  },
  { flag: "--show-in-grid <bool>", description: "Whether the vehicle appears in the grid (true/false)", optKey: "showInGrid", field: "showInGrid", parse: parseBoolFlag, modes: ["update"] },
  { flag: "--first-date <date>", description: "Start of validity window YYYY-MM-DD (firstDate; or today/yesterday/tomorrow)", optKey: "firstDate", field: "firstDate", modes: ["update"] },
  { flag: "--last-date <date>", description: "End of validity window YYYY-MM-DD (lastDate; or today/yesterday/tomorrow)", optKey: "lastDate", field: "lastDate", modes: ["update"] },
];

/** Parsed options of `vehicle create` / `vehicle update` — every field flag, all optional. */
type VehicleFieldOpts = Partial<Record<string, string | number | boolean>>;

/** Attach the field flags this mode exposes, in table order. */
function addVehicleFieldFlags(cmd: Command, mode: "create" | "update"): Command {
  for (const f of VEHICLE_FIELDS) {
    if (!f.modes.includes(mode)) continue;
    const description = typeof f.description === "string" ? f.description : f.description[mode];
    if (f.parse) cmd.option(f.flag, description, f.parse);
    else cmd.option(f.flag, description);
  }
  return cmd;
}

/**
 * Map parsed options to {@link VehicleWriteFields}. Flags absent for the mode
 * are simply `undefined`, which both writers already treat as "not supplied"
 * (create → null, update → keep current). The two date fields go through
 * `resolveDate` so `today`/`yesterday`/`tomorrow` expand.
 */
function vehicleFieldsFromOpts(opts: VehicleFieldOpts): VehicleWriteFields {
  const fields: Record<string, unknown> = {};
  for (const f of VEHICLE_FIELDS) {
    const value = opts[f.optKey];
    fields[f.field] =
      f.field === "firstDate" || f.field === "lastDate"
        ? resolveDate(value as string | undefined)
        : value;
  }
  return fields as VehicleWriteFields;
}

const VEHICLE_DIFF_FIELDS = [
  "asiakasId",
  "vehicleNo",
  "vehicleNimi",
  "vehicleRegNo",
  "firstDate",
  "lastDate",
  "vehicleTypeId",
  "memo",
  "showInGrid",
  "defaultKuski_personId",
  "vehicleM3",
  "vehiclePuomi",
] as const;

/**
 * Create a vehicle. The backend `vehicle_save` proc is UPDATE-only, so creation
 * is two-step: `POST /api/vehicle/new/:asiakasId` inserts a blank stub and
 * returns its `vehicleId`, then `POST /api/vehicle/save` populates it.
 *
 * The `/new` path param stamps BOTH `ownerAsiakasId` and `asiakasId` on the
 * stub, so `--asiakas` must ride the path — not just the save body — or a
 * cross-tenant create ends up owned by the caller's company (fb#94). Target =
 * `fields.asiakasId`, defaulting to the active JWT's company. The route guard
 * (`hasVehicleAccessOnAsiakas`) requires admin/owner/vehicleHandler on the
 * target tenant (sysadmin/developer pass). For a dry-run we only hit the
 * `/new` endpoint (with `X-Dry-Run`) and return the backend's preview — no save
 * is attempted. The `--reason` audit string is sent on both calls; the
 * `--idempotency-key` only applies to the populating save.
 */
export async function runVehicleCreate(
  client: ApiClient,
  fields: VehicleWriteFields,
  flags: WriteFlags
): Promise<unknown> {
  const ownerAsiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const targetAsiakasId = fields.asiakasId ?? ownerAsiakasId;
  if (flags.dryRun) {
    return client.post(
      `/api/vehicle/new/${targetAsiakasId}`,
      {},
      { headers: writeFlagsToHeaders(flags) }
    );
  }
  const created = await client.post<{ vehicleId: number }>(
    `/api/vehicle/new/${targetAsiakasId}`,
    {},
    { headers: writeFlagsToHeaders({ reason: flags.reason }) }
  );
  const body = {
    vehicleId: created.vehicleId,
    asiakasId: targetAsiakasId,
    vehicleNo: fields.vehicleNo ?? null,
    vehicleNimi: fields.vehicleNimi ?? null,
    vehicleRegNo: fields.vehicleRegNo ?? null,
    vehicleTypeId: fields.vehicleTypeId ?? null,
    memo: fields.memo ?? null,
    defaultKuski_personId: fields.defaultKuski_personId ?? null,
    vehicleM3: fields.vehicleM3 ?? null,
    vehiclePuomi: fields.vehiclePuomi ?? null,
  };
  return client.post("/api/vehicle/save", body, {
    headers: writeFlagsToHeaders({
      idempotencyKey: flags.idempotencyKey,
      reason: flags.reason,
    }),
  });
}

/**
 * Update a vehicle via read-merge-write: GET the full current row from the MAIN
 * `/api/vehicle/get/:id` endpoint (returns an array), overlay only the provided
 * `changes`, and POST the complete body to `/api/vehicle/save` (the proc expects
 * every column). Exits 5 (client-origin — the GET succeeded, the row is just
 * absent) when the vehicle is missing, so the caller surfaces "not found"
 * rather than a malformed save.
 *
 * `--dry-run` is resolved entirely client-side (the save route ignores
 * `X-Dry-Run`): it returns `{ dryRun: true, vehicleId, wouldChange:{ field:{
 * from, to } } }` — the field-level diff of what would change — and never
 * POSTs. Because no write leaves the process the preview cannot persist; the
 * trade-off is it skips backend-side validation (the real save still validates).
 */
export async function runVehicleUpdate(
  client: ApiClient,
  vehicleId: number,
  changes: VehicleWriteFields,
  flags: WriteFlags
): Promise<unknown> {
  const rows = await client.get<Array<Record<string, unknown>>>(
    `/api/vehicle/get/${vehicleId}`
  );
  const current = Array.isArray(rows)
    ? rows[0]
    : (rows as Record<string, unknown> | null);
  if (!current) {
    failWith(`Vehicle ${vehicleId} not found`, 5);
  }
  const body = {
    vehicleId,
    asiakasId: changes.asiakasId ?? current.asiakasId,
    vehicleNo: changes.vehicleNo ?? current.vehicleNo,
    vehicleNimi: changes.vehicleNimi ?? current.vehicleNimi,
    vehicleRegNo: changes.vehicleRegNo ?? current.vehicleRegNo,
    vehiclePuomi: changes.vehiclePuomi ?? current.vehiclePuomi,
    firstDate: changes.firstDate ?? current.firstDate,
    lastDate: changes.lastDate ?? current.lastDate,
    vehicleTypeId: changes.vehicleTypeId ?? current.vehicleTypeId,
    memo: changes.memo ?? current.memo,
    sortNo: current.sortNo,
    showInGrid: changes.showInGrid ?? current.showInGrid,
    defaultKuski_personId:
      changes.defaultKuski_personId ?? current.defaultKuski_personId,
    useNoDriverBar: current.useNoDriverBar,
    showInReports: current.showInReports,
    tuoteId: current.tuoteId,
    isRestricted: current.isRestricted,
    multiTenantVisibility: current.multiTenantVisibility,
    defaultVisibilityAsiakasIds: current.defaultVisibilityAsiakasIds,
    hasGpsTracking: current.hasGpsTracking,
    vehicleM3: changes.vehicleM3 ?? current.vehicleM3,
  };
  // The /api/vehicle/save route does not honour X-Dry-Run server-side, so the
  // preview is computed entirely client-side — it cannot persist. Report the
  // field-level diff (what would actually change) rather than the whole body.
  if (flags.dryRun) {
    return {
      dryRun: true,
      vehicleId,
      wouldChange: diffFields(current, body, VEHICLE_DIFF_FIELDS),
    };
  }
  return client.post("/api/vehicle/save", body, {
    headers: writeFlagsToHeaders(flags),
  });
}


/**
 * Register every `ib vehicle` subcommand on the parent commander instance.
 *
 * Reads: list, get, search, types, status, dates (list/expiring),
 * and GPS/telemetry — locations, timeline, route, visits.
 * Writes: create, update (carry the --dry-run/--reason/-idempotency write-safety flags).
 * The `driver` subgroup (day-driver dispatch + standing default driver) is
 * registered separately via `registerVehicleDriverCommands`.
 *
 * `src/reference/specs.ts` is the single source of truth for the authoritative
 * subcommand list, flags, permissions, and output shapes (also via
 * `ib vehicle --help` / `ib reference dump`) — keep this comment high-level so it
 * does not drift as commands are added.
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
 *
 * Exit codes: 1 = generic API/runtime failure (else the mapped CliError codes).
 */
export function registerVehicleCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  // `vehicles` — hidden bare-plural alias (fb#740): a documented group absorbs
  // the plural guess instead of costing a round-trip. `PLURAL_DOMAIN_ALIASES`
  // in domains.ts maps the token for selective registration; this makes
  // Commander dispatch it.
  const v = parent.command("vehicle").aliases(["vehicles"]).description("Vehicle commands");

  v.command("list")
    .option("--limit <n>", "", cappedInt(500))
    .option("--cursor <c>")
    .option("--deleted")
    .option("--grid-only")
    .option(
      "--valid-on <date>"
    )
    .option("--type <id>", "", (val: string) => Number(val))
    .option(
      "--asiakas <id>",
      "",
      intFlag("--asiakas")
    )
    .action(
      jsonAction(
        getClient,
        (
          client,
          opts: {
            limit?: number;
            cursor?: string;
            deleted?: boolean;
            gridOnly?: boolean;
            validOn?: string;
            type?: number;
            asiakas?: number;
          }
        ) =>
          runVehicleList(client, {
            limit: opts.limit,
            cursor: opts.cursor,
            deleted: opts.deleted,
            gridOnly: opts.gridOnly,
            validOn: resolveDate(opts.validOn),
            type: opts.type,
            asiakas: opts.asiakas,
          })
      )
    );

  v.command("get <vehicleId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .option(
      "--asiakas <id>",
      "",
      intFlag("--asiakas")
    )
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { asiakas?: number }) =>
        runVehicleGet(client, parseId(idStr, "vehicleId"), opts.asiakas)
      )
    );

  v.command("status <vehicleId>")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runVehicleStatus(client, parseId(idStr, "vehicleId"))
      )
    );


  v.command("types")
    .option(
      "--asiakas <id>",
      "",
      intFlag("--asiakas")
    )
    .action(
      jsonAction(getClient, (client, opts: { asiakas?: number }) =>
        runVehicleTypes(client, opts.asiakas)
      )
    );

  v.command("locations")
    .action(jsonAction(getClient, runVehicleLocations));

  v.command("search [query]")
    .option("--search <s>")
    .addOption(queryAliasOption())
    .option("--limit <n>", "", cappedInt(500))
    .option(
      "--asiakas <id>",
      "",
      intFlag("--asiakas")
    )
    .action(
      jsonAction(getClient, (client, query: string | undefined, opts: { search?: string; query?: string; limit?: number; asiakas?: number }) =>
        runVehicleSearch(client, resolveSearchQuery(query, opts.search, opts.query), opts.limit, opts.asiakas)
      )
    );

  v.command("timeline <vehicleId>")
    .option("--date <date>", "", "today")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: VehicleDayFilter) =>
        runVehicleTimeline(client, parseId(idStr, "vehicleId"), { date: resolveDate(opts.date) })
      )
    );

  const createCmd = addVehicleFieldFlags(v.command("create"), "create");
  addWriteFlagsToCommand(createCmd).action(
    guarded(async (opts: WriteFlags & VehicleFieldOpts) => {
      const result = await runVehicleCreate(
        await getClient(),
        vehicleFieldsFromOpts(opts),
        opts
      );
      writeJson(result);
    })
  );

  const updateCmd = addVehicleFieldFlags(v.command("update <vehicleId>"), "update");
  addWriteFlagsToCommand(updateCmd).action(
    guarded(async (idStr: string, opts: WriteFlags & VehicleFieldOpts) => {
      const result = await runVehicleUpdate(
        await getClient(),
        parseId(idStr, "vehicleId"),
        vehicleFieldsFromOpts(opts),
        opts
      );
      writeJson(result);
    })
  );

  const dates = v
    .command("dates")
    .description("Vehicle inspection/cert date reads");
  dates
    .command("list <vehicleId>")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runVehicleDatesList(client, parseId(idStr, "vehicleId"))
      )
    );
  dates
    .command("expiring")
    .option("--days <n>", "", (s: string) =>
      Number(s)
    )
    .action(
      jsonAction(getClient, (client, opts: { days?: number }) =>
        runVehicleDatesExpiring(client, opts.days)
      )
    );

  v.command("route <vehicleId>")
    .option("--date <date>", "", "today")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: VehicleDayFilter) =>
        runVehicleRoute(client, parseId(idStr, "vehicleId"), { date: resolveDate(opts.date) })
      )
    );

  v.command("visits <filterType> <id>")
    .option("--days <n>", "", (val: string) => Number(val))
    .option(
      "--date <d>"
    )
    .action(
      jsonAction(getClient, (client, filterType: string, idStr: string, opts: VehicleVisitsFilter) =>
        runVehicleVisits(client, filterType, parseId(idStr, "vehicleId"), {
          days: opts.days,
          date: opts.date ? resolveDate(opts.date) : undefined,
        })
      )
    );

  registerLogAlias(v, getClient, "vehicle", "vehicleId");

  // The vehicle-driver subgroup: day-driver dispatch + standing default driver.
  registerVehicleDriverCommands(v, getClient);
}
