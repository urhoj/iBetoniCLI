import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";

/**
 * Sentinel `jerryActiveUntil` value meaning "enrolled in BetoniJerry, no end
 * date" — matches the EditSijainti toggle (a future/sentinel datetime = active,
 * NULL = not enrolled). See sijainti.jerryActiveUntil in geoCodeSql.js.
 */
const JERRY_ACTIVE_SENTINEL = "9999-12-31 23:59:59";

/** Typed convenience fields for `create`/`update`, mapped to backend names. */
export interface SijaintiTypedFields {
  id?: number;
  name?: string;
  address?: string;
  type?: number;
  lat?: number;
  lng?: number;
  /** sijaintiLyh — short code/abbreviation (NOT NULL, ≤50 chars, no DB default). */
  lyh?: string;
  /** maxDeliveryDistance — km (NOT NULL; DB default 50 does NOT apply on insert). */
  maxDeliveryDistance?: number;
  /** asiakasId — owning company (NOT NULL FK; create defaults to active company). */
  asiakasId?: number;
}

/**
 * Merge typed convenience flags over a parsed --body object (typed flags win).
 * `--id` maps to sijaintiId (update only); the rest map to the backend column
 * names. Body keys not covered by a typed flag are preserved untouched.
 */
export function buildSijaintiBody(
  parsedBody: Record<string, unknown>,
  typed: SijaintiTypedFields
): Record<string, unknown> {
  const body = { ...parsedBody };
  if (typed.id !== undefined) body.sijaintiId = typed.id;
  if (typed.name !== undefined) body.sijaintiNimi = typed.name;
  if (typed.address !== undefined) body.sijaintiOsoite1 = typed.address;
  if (typed.type !== undefined) body.sijaintiTypeId = typed.type;
  if (typed.lat !== undefined) body.lat = typed.lat;
  if (typed.lng !== undefined) body.lng = typed.lng;
  if (typed.lyh !== undefined) body.sijaintiLyh = typed.lyh;
  if (typed.maxDeliveryDistance !== undefined)
    body.maxDeliveryDistance = typed.maxDeliveryDistance;
  if (typed.asiakasId !== undefined) body.asiakasId = typed.asiakasId;
  return body;
}

/** Max length of sijaintiLyh in the DB (nvarchar(50)). */
const SIJAINTI_LYH_MAX = 50;
/** maxDeliveryDistance DB default — the value the create proc fails to apply itself. */
const DEFAULT_MAX_DELIVERY_DISTANCE = 50;

/**
 * Fill the create-only mandatory columns the `sijainti_add` proc inserts WITHOUT
 * a COALESCE/default fallback, so a minimal create succeeds instead of hitting a
 * NOT NULL violation (which `--dry-run` historically did not reveal):
 *   - sijaintiNimi / sijaintiTypeId — required; reported in `missing` if absent.
 *   - sijaintiLyh — NOT NULL, no DB default → default to sijaintiNimi (≤50 chars).
 *   - maxDeliveryDistance — NOT NULL, DB default not applied on insert → default 50.
 * Pure (no asiakasId resolution — that needs the client); mutates+returns `body`.
 */
export function applySijaintiCreateDefaults(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  missing: string[];
} {
  const missing: string[] = [];
  const name = body.sijaintiNimi;
  if (name === undefined || name === null || name === "") missing.push("--name (sijaintiNimi)");
  if (body.sijaintiTypeId === undefined || body.sijaintiTypeId === null)
    missing.push("--type (sijaintiTypeId)");

  const lyh = body.sijaintiLyh;
  if ((lyh === undefined || lyh === null || lyh === "") && typeof name === "string") {
    body.sijaintiLyh = name.slice(0, SIJAINTI_LYH_MAX);
  }
  if (body.maxDeliveryDistance === undefined || body.maxDeliveryDistance === null) {
    body.maxDeliveryDistance = DEFAULT_MAX_DELIVERY_DISTANCE;
  }
  return { body, missing };
}

/**
 * Pull {lat,lng} out of the /api/geocode/getLatLng response — the raw Google
 * Geocoding payload (`results[0].geometry.location`), with a top-level
 * {lat,lng} fallback. Returns null for ZERO_RESULTS / error / 0,0 shapes.
 */
export function extractGeocodeLatLng(geo: unknown): { lat: number; lng: number } | null {
  const g = geo as Record<string, unknown> | null;
  if (!g || typeof g !== "object") return null;
  const loc =
    (g.results as Array<{ geometry?: { location?: { lat?: unknown; lng?: unknown } } }> | undefined)?.[0]
      ?.geometry?.location ?? { lat: g.lat, lng: g.lng };
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    return { lat, lng };
  }
  return null;
}

export interface SijaintiListFilter {
  type?: string;
  limit?: number;
  validAt?: string;
  includeDeleted?: boolean;
}

/**
 * GET /api/cli/sijainti/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runSijaintiList(
  client: ApiClient,
  opts: SijaintiListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.validAt) params.set("validAtDate", opts.validAt);
  if (opts.includeDeleted) params.set("includeDeleted", "1");
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/sijainti/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/geocode/sijainti/get/:sijaintiId — existing geocode route (not
 * /api/cli/) reused for v1.0 reads. Returns the flat backend record as-is.
 */
export async function runSijaintiGet(
  client: ApiClient,
  sijaintiId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/geocode/sijainti/get/${sijaintiId}`
  );
}

/**
 * POST /api/geocode/sijainti/add with a free-form body forwarded to the
 * existing BE endpoint. Write flags surface as the universal `X-Dry-Run` /
 * `Idempotency-Key` / `X-Action-Reason` headers.
 */
export async function runSijaintiCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/geocode/sijainti/add", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * POST /api/geocode/updateSijainti with a free-form body. The target
 * `sijaintiId` is carried IN the body (not the URL) — this matches the
 * existing geocodeRoutes.js shape.
 */
export async function runSijaintiUpdate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/geocode/updateSijainti", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Default BetoniJerry delivery radius (km) applied when a varikko is enrolled
 * (`--on`) but has no usable `maxDeliveryDistance` — enrolling with 0 km would
 * cover nothing. Mid-range of the typical 30–80 km a varikko serves.
 */
const DEFAULT_JERRY_RADIUS_KM = 50;

/**
 * Enrol/unenrol a varikko in BetoniJerry. There is no partial-update route, so
 * this replicates the EditSijainti save: GET the current row, override
 * `jerryActiveUntil` (sentinel = on, null = off), and POST it back through
 * /api/geocode/updateSijainti (extractSijaintiBody whitelists the persisted
 * fields, so the round-trip preserves the rest of the row). `--dry-run` is
 * honoured server-side.
 *
 * Coverage note: BetoniJerry feasibility (`services/varikkoMatching`) keys on
 * `maxDeliveryDistance` (KM) — NOT `geofenceRadius` (metres, a GPS depot
 * detector). So enrolling alone isn't enough; the varikko also needs a delivery
 * radius. On `--on` we set it from `radius` (km), or default it to
 * DEFAULT_JERRY_RADIUS_KM when the varikko currently has none — otherwise the
 * varikko would be "enrolled but covering nothing".
 */
export async function runSijaintiSetJerry(
  client: ApiClient,
  sijaintiId: number,
  on: boolean,
  flags: WriteFlags,
  radius?: number
): Promise<unknown> {
  const current = await client.get<Record<string, unknown>>(
    `/api/geocode/sijainti/get/${sijaintiId}`
  );
  const body: Record<string, unknown> = {
    ...current,
    sijaintiId,
    jerryActiveUntil: on ? JERRY_ACTIVE_SENTINEL : null,
  };
  if (on) {
    if (radius !== undefined) {
      body.maxDeliveryDistance = radius;
    } else if (!Number(current.maxDeliveryDistance)) {
      body.maxDeliveryDistance = DEFAULT_JERRY_RADIUS_KM;
    }
  }
  return client.post<unknown>("/api/geocode/updateSijainti", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * DELETE /api/geocode/sijainti/delete/:sijaintiId — soft-delete (sets
 * deletedTime). Server-side gate: validateSijaintiWriteAccess. Write flags
 * surface as the universal headers; --reason is enforced at the CLI layer.
 */
export async function runSijaintiDelete(
  client: ApiClient,
  sijaintiId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete(`/api/geocode/sijainti/delete/${sijaintiId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * POST /api/geocode/sijainti/undelete/:sijaintiId — restore a soft-deleted
 * sijainti. Empty body; same write gate as delete.
 */
export async function runSijaintiUndelete(
  client: ApiClient,
  sijaintiId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    `/api/geocode/sijainti/undelete/${sijaintiId}`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

export interface SijaintiTypeItem {
  sijaintiTypeId: number;
  selite: string | null;
}

/**
 * GET /api/geocode/sijaintiTypes — the "Sijainnin laji" lookup. Projects the
 * backend `{sijaintiTypeId, sijaintiTypeSelite}` rows into the universal list
 * envelope with a tidy `selite` field. `--jerry` switches to the BetoniJerry
 * type set (useJerry=1).
 */
export async function runSijaintiTypes(
  client: ApiClient,
  useJerry?: boolean
): Promise<ListEnvelope<SijaintiTypeItem>> {
  const rows = await client.get<
    Array<{ sijaintiTypeId: number; sijaintiTypeSelite?: string | null }>
  >(`/api/geocode/sijaintiTypes${useJerry ? "?useJerry=1" : ""}`);
  const items = (rows || []).map((r) => ({
    sijaintiTypeId: r.sijaintiTypeId,
    selite: r.sijaintiTypeSelite ?? null,
  }));
  return { items, nextCursor: null, count: items.length };
}

/**
 * POST /api/geocode/getLatLng — geocode a free-form address string to
 * coordinates via Google Maps. The backend derives ownerAsiakasId from the
 * token. Returns the raw Google geocode result verbatim (shape:
 * `{ status, lat, lng, ... }`; `{ status: "ZERO_RESULTS" }` when the address
 * is shorter than 5 characters or has no match). Read-only, no write flags.
 */
export async function runSijaintiGeocode(
  client: ApiClient,
  address: string
): Promise<unknown> {
  return client.post<unknown>("/api/geocode/getLatLng", { osoite: address });
}

/**
 * Resolve the caller's active ownerAsiakasId via the existing
 * /api/company-selection/available route. Used by closest/distance, whose
 * legacy geocode routes still take asiakasId as a URL positional.
 */
async function resolveOwnerAsiakasId(client: ApiClient): Promise<number> {
  const available = await client.get<{ currentCompanyId?: number }>(
    "/api/company-selection/available"
  );
  // Guard the falsy case: the backend derives currentCompanyId from the token's
  // ownerAsiakasId and returns undefined when it is absent. Without this, the
  // value would interpolate into the closest/distance URL as the string
  // "undefined" (→ NaN server-side) and silently return zero results instead of
  // a clear error.
  if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
    throw new Error(
      "could not resolve active company — run `ib auth switch` or pass --asiakas"
    );
  }
  return available.currentCompanyId;
}

export interface SijaintiClosestFilter {
  tyomaaId: number;
  sijaintiTypeId: number;
  asiakasId?: number;
}

/**
 * GET /api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa — nearest
 * sijainti of the given type to a worksite (straight-line / Haversine).
 *
 * The legacy route path carries a `:sijaintiId` segment the handler IGNORES —
 * we pass `0`. asiakasId defaults to the caller's active company. The raw
 * response is a createSuccessResponse envelope (matkaM/min/timestamp noise);
 * we project to just `{ closestSijainti, closestDistance }`.
 */
export async function runSijaintiClosest(
  client: ApiClient,
  opts: SijaintiClosestFilter
): Promise<{ closestSijainti: unknown; closestDistance: number | null }> {
  const asiakasId = opts.asiakasId ?? (await resolveOwnerAsiakasId(client));
  const raw = await client.get<{
    closestSijainti?: unknown;
    closestDistance?: number;
  }>(
    `/api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa/${opts.tyomaaId}/0/${opts.sijaintiTypeId}/${asiakasId}`
  );
  return {
    closestSijainti: raw.closestSijainti ?? null,
    closestDistance: raw.closestDistance ?? null,
  };
}

/** Parse a "lat,lng" token into coordinates, or null if it is not that shape. */
function parseCoordToken(token: string): { lat: number; lng: number } | null {
  // Require exactly two non-empty parts so a truncated token like "60.17," is
  // rejected (Number("") is 0, which would otherwise pass as lng=0) and a
  // malformed "60,24,5" doesn't silently drop its tail.
  const parts = token.split(",");
  if (parts.length !== 2) return null;
  const [rawA, rawB] = parts.map((x) => x.trim());
  if (!rawA || !rawB) return null;
  const a = Number(rawA);
  const b = Number(rawB);
  if (Number.isFinite(a) && Number.isFinite(b)) return { lat: a, lng: b };
  return null;
}

/**
 * Synchronously validate a distance point token. Returns the coords if it is a
 * "lat,lng" string, returns the integer sijaintiId if it is a bare id, or
 * throws a validation error (caller exits 4) if it is neither.
 */
function parseDistanceToken(token: string): { lat: number; lng: number } | number {
  const coord = parseCoordToken(token);
  if (coord) return coord;
  const id = Number(token);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid point '${token}' — use 'lat,lng' or a sijaintiId`);
  }
  return id;
}

/**
 * Resolve a distance endpoint token to coordinates. Accepts "lat,lng" or a
 * bare sijaintiId (resolved via runSijaintiGet → its lat/lng). Throws a
 * validation error (caller exits 4) on a malformed token or a sijainti with
 * no coordinates.
 */
async function resolveDistancePoint(
  client: ApiClient,
  token: string
): Promise<{ lat: number; lng: number }> {
  const parsed = parseDistanceToken(token);
  if (typeof parsed === "object") return parsed;
  const row = (await runSijaintiGet(client, parsed)) as { lat?: number; lng?: number };
  if (typeof row.lat !== "number" || typeof row.lng !== "number") {
    throw new Error(`sijainti ${parsed} has no coordinates`);
  }
  return { lat: row.lat, lng: row.lng };
}

/**
 * GET /api/geocode/getDrivingDistance — driving distance/time between two
 * points (each "lat,lng" or a sijaintiId). ownerAsiakasId is resolved from the
 * active company (the legacy route takes it as a URL positional). Projects the
 * backend `{matkaM, matkaAika, ...}` to `{ matkaM, matkaMin, from, to }`.
 */
export async function runSijaintiDistance(
  client: ApiClient,
  fromToken: string,
  toToken: string
): Promise<{
  matkaM: number | null;
  matkaMin: number | null;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
}> {
  // Validate tokens synchronously before issuing any network calls so that a
  // malformed token rejects immediately without touching the API.
  parseDistanceToken(fromToken);
  parseDistanceToken(toToken);
  const [from, to, ownerAsiakasId] = await Promise.all([
    resolveDistancePoint(client, fromToken),
    resolveDistancePoint(client, toToken),
    resolveOwnerAsiakasId(client),
  ]);
  const raw = await client.get<{ matkaM?: number; matkaAika?: number }>(
    `/api/geocode/getDrivingDistance/${from.lat}/${from.lng}/${to.lat}/${to.lng}/${ownerAsiakasId}`
  );
  return {
    matkaM: raw.matkaM ?? null,
    matkaMin: raw.matkaAika ?? null,
    from,
    to,
  };
}

/**
 * Register `ib sijainti` subcommands on the parent commander instance:
 *   - list      filterable by --type/--limit/--valid-at/--include-deleted
 *   - get       single sijainti by id (existing /api/geocode/sijainti route)
 *   - types     sijainti type lookup (sijaintiTypeId → selite)
 *   - geocode   address → coords via Google Maps
 *   - closest   nearest sijainti of a type to a worksite
 *   - distance  driving distance/time between two points
 *   - create    POST /api/geocode/sijainti/add — required --name/--type; --lyh,
 *               --max-distance, --asiakas auto-default (typed flags or --body JSON)
 *   - update    POST /api/geocode/updateSijainti (typed flags or --body JSON)
 *   - delete    soft-delete (requires --reason)
 *   - undelete  restore a soft-deleted sijainti (requires --reason)
 *   - set-jerry enrol/unenrol a varikko in BetoniJerry (jerryActiveUntil)
 *
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerSijaintiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const s = parent.command("sijainti").description("Sijainti (location) commands");

  s.command("list")
    .description("List sijainti (locations)")
    .option("--type <t>", "Filter by sijainti type")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .option(
      "--valid-at <date>",
      "Only sijainnit valid on this date (YYYY-MM-DD or today/yesterday/tomorrow)"
    )
    .option("--include-deleted", "Include soft-deleted sijainnit")
    .action(
      async (opts: {
        type?: string;
        limit?: number;
        validAt?: string;
        includeDeleted?: boolean;
      }) => {
        try {
          const client = await getClient();
          const result = await runSijaintiList(client, {
            type: opts.type,
            limit: opts.limit,
            validAt: opts.validAt ? resolveDate(opts.validAt) : undefined,
            includeDeleted: opts.includeDeleted,
          });
          writeJson(result);
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  s.command("get <sijaintiId>")
    .description("Get a single sijainti by sijaintiId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runSijaintiGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  const createCmd = s
    .command("create")
    .description(
      "Create a new sijainti (POST /api/geocode/sijainti/add). Required: --name, --type. " +
        "--lyh defaults to --name (≤50 chars), --max-distance to 50, --asiakas to your active company. " +
        "--geocode auto-fills lat/lng from the address when coordinates are not given. " +
        "Use typed flags or --body JSON (typed flags win)."
    )
    .option("--body <json>", "JSON object forwarded as the request body")
    .option("--name <n>", "sijaintiNimi (required)")
    .option("--address <a>", "sijaintiOsoite1 (street)")
    .option("--type <id>", "sijaintiTypeId (required; see `ib sijainti types`)", Number)
    .option("--lat <n>", "Latitude", Number)
    .option("--lng <n>", "Longitude", Number)
    .option("--lyh <s>", "sijaintiLyh — short code/abbreviation (≤50 chars; defaults to --name)")
    .option("--max-distance <n>", "maxDeliveryDistance in km (default 50)", Number)
    .option("--asiakas <id>", "Owner asiakasId (defaults to your active company)", Number)
    .option(
      "--geocode",
      "Auto-fill lat/lng from the address via Google Maps when coordinates are not given"
    );
  addWriteFlagsToCommand(createCmd).action(
    async (opts: {
      body?: string;
      name?: string;
      address?: string;
      type?: number;
      lat?: number;
      lng?: number;
      lyh?: string;
      maxDistance?: number;
      asiakas?: number;
      geocode?: boolean;
      dryRun?: boolean;
      idempotencyKey?: string;
      reason?: string;
    }) => {
      try {
        const client = await getClient();
        const parsed = opts.body
          ? parseJsonBodyFlag(opts.body)
          : {};
        const body = buildSijaintiBody(parsed, {
          name: opts.name,
          address: opts.address,
          type: opts.type,
          lat: opts.lat,
          lng: opts.lng,
          lyh: opts.lyh,
          maxDeliveryDistance: opts.maxDistance,
          asiakasId: opts.asiakas,
        });
        // asiakasId is a NOT NULL FK the add proc inserts directly — default it
        // to the caller's active company when neither --asiakas nor --body gave one.
        if (body.asiakasId === undefined || body.asiakasId === null) {
          body.asiakasId = await resolveOwnerAsiakasId(client);
        }
        // Fill sijaintiLyh / maxDeliveryDistance defaults and check the required
        // fields the add proc inserts without a fallback (so we fail fast with a
        // clear message instead of a NOT NULL 500 that --dry-run used to miss).
        const { missing } = applySijaintiCreateDefaults(body);
        if (missing.length > 0) {
          writeError(new Error(`create requires: ${missing.join(", ")}`));
          process.exit(4);
        }
        // --geocode: eagerly resolve lat/lng from the address (otherwise the row
        // is created without coordinates and a nightly job backfills them later).
        if (opts.geocode && (body.lat === undefined || body.lat === null || body.lng === undefined || body.lng === null)) {
          const address = typeof body.sijaintiOsoite1 === "string" ? body.sijaintiOsoite1 : "";
          if (!address) {
            writeError(new Error("--geocode requires --address (or sijaintiOsoite1 in --body)"));
            process.exit(4);
          }
          const geo = await runSijaintiGeocode(client, address);
          const coords = extractGeocodeLatLng(geo);
          if (!coords) {
            const status = (geo as { status?: string } | null)?.status ?? "no match";
            writeError(new Error(`could not geocode address "${address}" (status: ${status})`));
            process.exit(4);
          }
          body.lat = coords.lat;
          body.lng = coords.lng;
        }
        const result = await runSijaintiCreate(client, body, {
          dryRun: opts.dryRun,
          idempotencyKey: opts.idempotencyKey,
          reason: opts.reason,
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const updateCmd = s
    .command("update")
    .description(
      "Update a sijainti (POST /api/geocode/updateSijainti). sijaintiId via --id or in --body. Typed flags win over --body."
    )
    .option("--body <json>", "JSON object forwarded as the request body")
    .option("--id <sijaintiId>", "Target sijaintiId", Number)
    .option("--name <n>", "sijaintiNimi")
    .option("--address <a>", "sijaintiOsoite1 (street)")
    .option("--type <id>", "sijaintiTypeId", Number)
    .option("--lat <n>", "Latitude", Number)
    .option("--lng <n>", "Longitude", Number)
    .option("--lyh <s>", "sijaintiLyh — short code/abbreviation (≤50 chars)")
    .option("--max-distance <n>", "maxDeliveryDistance in km", Number);
  addWriteFlagsToCommand(updateCmd).action(
    async (opts: {
      body?: string;
      id?: number;
      name?: string;
      address?: string;
      type?: number;
      lat?: number;
      lng?: number;
      lyh?: string;
      maxDistance?: number;
      dryRun?: boolean;
      idempotencyKey?: string;
      reason?: string;
    }) => {
      try {
        const client = await getClient();
        const parsed = opts.body
          ? parseJsonBodyFlag(opts.body)
          : {};
        const body = buildSijaintiBody(parsed, {
          id: opts.id,
          name: opts.name,
          address: opts.address,
          type: opts.type,
          lat: opts.lat,
          lng: opts.lng,
          lyh: opts.lyh,
          maxDeliveryDistance: opts.maxDistance,
        });
        if (body.sijaintiId === undefined) {
          writeError(
            new Error("update requires sijaintiId — pass --id or include it in --body")
          );
          process.exit(4);
        }
        const result = await runSijaintiUpdate(client, body, {
          dryRun: opts.dryRun,
          idempotencyKey: opts.idempotencyKey,
          reason: opts.reason,
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const setJerryCmd = s
    .command("set-jerry <sijaintiId>")
    .description(
      "Enrol/unenrol a varikko in BetoniJerry (--on/--off). BetoniJerry coverage " +
        "keys on the delivery radius maxDeliveryDistance (KM) — NOT geofenceRadius " +
        "(metres, a GPS depot detector) — so --on also sets that radius: --radius " +
        "<km>, or a 50 km default when the varikko has none (otherwise it would be " +
        "enrolled but cover nothing). Also requires the company's isPumppuToimittaja flag."
    )
    .option("--on", "Enrol: jerryActiveUntil = sentinel + ensure a delivery radius")
    .option("--off", "Unenrol: jerryActiveUntil = null")
    .option("--radius <km>", "Delivery radius in km (maxDeliveryDistance) to set when enrolling", Number);
  addWriteFlagsToCommand(setJerryCmd).action(
    async (
      idStr: string,
      opts: {
        on?: boolean;
        off?: boolean;
        radius?: number;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
      }
    ) => {
      if (opts.on === opts.off) {
        // neither or both given — ambiguous
        writeError(new Error("Pass exactly one of --on / --off"));
        process.exit(4);
      }
      if (opts.radius !== undefined && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
        writeError(new Error("--radius must be a positive number of km"));
        process.exit(4);
      }
      try {
        const client = await getClient();
        const result = await runSijaintiSetJerry(
          client,
          Number(idStr),
          !!opts.on,
          {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
          },
          opts.radius
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    s
      .command("delete <sijaintiId>")
      .description(
        "Soft-delete a sijainti (DELETE /api/geocode/sijainti/delete/:id). Requires --reason."
      )
  ).action(async (idStr: string, opts: WriteFlags) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runSijaintiDelete(client, Number(idStr), opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    s
      .command("undelete <sijaintiId>")
      .description(
        "Restore a soft-deleted sijainti (POST /api/geocode/sijainti/undelete/:id). Requires --reason."
      )
  ).action(async (idStr: string, opts: WriteFlags) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runSijaintiUndelete(client, Number(idStr), opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  s.command("types")
    .description(
      "List sijainti type categories (the 'Sijainnin laji' lookup; maps sijaintiTypeId → selite)"
    )
    .option("--jerry", "Use the BetoniJerry sijainti type set")
    .action(async (opts: { jerry?: boolean }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiTypes(client, opts.jerry);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  s.command("geocode")
    .description(
      "Geocode an address string to coordinates (POST /api/geocode/getLatLng, Google Maps)"
    )
    .requiredOption("--address <a>", "Free-form address to geocode")
    .action(async (opts: { address: string }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiGeocode(client, opts.address);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  s.command("closest")
    .description(
      "Find the closest sijainti of a given type to a worksite (straight-line distance)"
    )
    .requiredOption("--tyomaa <id>", "Target tyomaaId", Number)
    .requiredOption("--type <id>", "sijaintiTypeId to search within", Number)
    .option("--asiakas <id>", "Owner asiakasId (defaults to active company)", Number)
    .action(async (opts: { tyomaa: number; type: number; asiakas?: number }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiClosest(client, {
          tyomaaId: opts.tyomaa,
          sijaintiTypeId: opts.type,
          asiakasId: opts.asiakas,
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  s.command("distance")
    .description(
      "Driving distance/time between two points (each is 'lat,lng' or a sijaintiId)"
    )
    .requiredOption("--from <point>", "Origin: 'lat,lng' or a sijaintiId")
    .requiredOption("--to <point>", "Destination: 'lat,lng' or a sijaintiId")
    .action(async (opts: { from: string; to: string }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiDistance(client, opts.from, opts.to);
        writeJson(result);
      } catch (e) {
        // A bad point token is a validation error (exit 4); API/network errors
        // keep their contract-mapped codes via exitWithError.
        if (
          e instanceof Error &&
          (e.message.startsWith("invalid point") ||
            e.message.includes("has no coordinates"))
        ) {
          writeError(e);
          process.exit(4);
        }
        exitWithError(e);
      }
    });
}
