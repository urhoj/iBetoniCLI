import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith, errorMessage, } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { CliError } from "../../api/errors.js";
/**
 * Sentinel `jerryActiveUntil` value meaning "enrolled in BetoniJerry, no end
 * date" — matches the EditSijainti toggle (a future/sentinel datetime = active,
 * NULL = not enrolled). See sijainti.jerryActiveUntil in geoCodeSql.js.
 */
const JERRY_ACTIVE_SENTINEL = "9999-12-31 23:59:59";
/**
 * Merge typed convenience flags over a parsed --body object (typed flags win).
 * `--id` maps to sijaintiId (update only); the rest map to the backend column
 * names. Body keys not covered by a typed flag are preserved untouched.
 */
export function buildSijaintiBody(parsedBody, typed) {
    const body = { ...parsedBody };
    if (typed.id !== undefined)
        body.sijaintiId = typed.id;
    if (typed.name !== undefined)
        body.sijaintiNimi = typed.name;
    if (typed.address !== undefined)
        body.sijaintiOsoite1 = typed.address;
    if (typed.type !== undefined)
        body.sijaintiTypeId = typed.type;
    if (typed.lat !== undefined)
        body.lat = typed.lat;
    if (typed.lng !== undefined)
        body.lng = typed.lng;
    if (typed.lyh !== undefined)
        body.sijaintiLyh = typed.lyh;
    if (typed.maxDeliveryDistance !== undefined)
        body.maxDeliveryDistance = typed.maxDeliveryDistance;
    if (typed.asiakasId !== undefined)
        body.asiakasId = typed.asiakasId;
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
export function applySijaintiCreateDefaults(body) {
    const missing = [];
    const name = body.sijaintiNimi;
    if (name === undefined || name === null || name === "")
        missing.push("--name (sijaintiNimi)");
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
export function extractGeocodeLatLng(geo) {
    const g = geo;
    if (!g || typeof g !== "object")
        return null;
    const loc = g.results?.[0]
        ?.geometry?.location ?? { lat: g.lat, lng: g.lng };
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        return { lat, lng };
    }
    return null;
}
/**
 * GET /api/cli/sijainti/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 *
 * Default visibility is own company + shared (asiakasId 0); `all` maps to
 * `?scope=all` which also surfaces OTHER companies' sijainnit (supplier
 * betoniasemat etc. — the same rows GPS visits/timeline are tagged with).
 */
export async function runSijaintiList(client, opts) {
    const params = new URLSearchParams();
    if (opts.type)
        params.set("type", opts.type);
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.validAt)
        params.set("validAtDate", opts.validAt);
    if (opts.includeDeleted)
        params.set("includeDeleted", "1");
    if (opts.search)
        params.set("search", opts.search);
    if (opts.all)
        params.set("scope", "all");
    const qs = params.toString();
    return client.get(`/api/cli/sijainti/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/geocode/sijainti/get/:sijaintiId — existing geocode route (not
 * /api/cli/) reused for v1.0 reads. Returns the flat backend record as-is.
 */
export async function runSijaintiGet(client, sijaintiId) {
    return client.get(`/api/geocode/sijainti/get/${sijaintiId}`);
}
/**
 * POST /api/geocode/sijainti/add with a free-form body forwarded to the
 * existing BE endpoint. Write flags surface as the universal `X-Dry-Run` /
 * `Idempotency-Key` / `X-Action-Reason` headers.
 */
export async function runSijaintiCreate(client, body, flags) {
    return client.post("/api/geocode/sijainti/add", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * POST /api/geocode/updateSijainti with a free-form body. The target
 * `sijaintiId` is carried IN the body (not the URL) — this matches the
 * existing geocodeRoutes.js shape.
 */
export async function runSijaintiUpdate(client, body, flags) {
    return client.post("/api/geocode/updateSijainti", body, {
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
export async function runSijaintiSetJerry(client, sijaintiId, on, flags, radius) {
    const current = await client.get(`/api/geocode/sijainti/get/${sijaintiId}`);
    const body = {
        ...current,
        sijaintiId,
        jerryActiveUntil: on ? JERRY_ACTIVE_SENTINEL : null,
    };
    if (on) {
        if (radius !== undefined) {
            body.maxDeliveryDistance = radius;
        }
        else if (!Number(current.maxDeliveryDistance)) {
            body.maxDeliveryDistance = DEFAULT_JERRY_RADIUS_KM;
        }
    }
    return client.post("/api/geocode/updateSijainti", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * DELETE /api/geocode/sijainti/delete/:sijaintiId — soft-delete (sets
 * deletedTime). Server-side gate: validateSijaintiWriteAccess. Write flags
 * surface as the universal headers; --reason is enforced at the CLI layer.
 */
export async function runSijaintiDelete(client, sijaintiId, flags) {
    return client.delete(`/api/geocode/sijainti/delete/${sijaintiId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * POST /api/geocode/sijainti/undelete/:sijaintiId — restore a soft-deleted
 * sijainti. Empty body; same write gate as delete.
 */
export async function runSijaintiUndelete(client, sijaintiId, flags) {
    return client.post(`/api/geocode/sijainti/undelete/${sijaintiId}`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * GET /api/geocode/sijaintiTypes — the "Sijainnin laji" lookup. Projects the
 * backend `{sijaintiTypeId, sijaintiTypeSelite}` rows into the universal list
 * envelope with a tidy `selite` field. `--jerry` switches to the BetoniJerry
 * type set (useJerry=1).
 */
export async function runSijaintiTypes(client, useJerry) {
    const rows = await client.get(`/api/geocode/sijaintiTypes${useJerry ? "?useJerry=1" : ""}`);
    const items = (rows || []).map((r) => ({
        sijaintiTypeId: r.sijaintiTypeId,
        selite: r.sijaintiTypeSelite ?? null,
    }));
    return { items, nextCursor: null, count: items.length };
}
/** Backend list cap — what a client-side `--search` scan fetches to cover the set. */
export const SIJAINTI_SEARCH_SCAN_LIMIT = 500;
/** Backend list default, re-applied after a client-side search filter. */
const DEFAULT_LIST_LIMIT = 100;
/**
 * Case-insensitive substring match over a (typeName-joined) list row's
 * searchable fields: name, address, typeName. Shared by `sijainti list
 * --search` and the sijainti entity of `ib search`.
 */
export function sijaintiRowMatches(row, query) {
    const q = query.toLowerCase();
    return [row.name, row.address, row.typeName].some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}
/**
 * Resolve a `--type` value to a numeric sijaintiTypeId against the
 * sijaintiTypes lookup. Numeric input passes through (an unknown id simply
 * matches no rows server-side). Names match the selite case-insensitively —
 * exact match wins, else a unique substring (e.g. "jäte" → Jäteasema); an
 * unknown or ambiguous name throws a validation error (exit 4) listing the
 * valid types so the caller can self-correct.
 */
export function resolveSijaintiTypeId(types, input) {
    const n = Number(input);
    if (Number.isInteger(n) && n > 0)
        return n;
    const q = input.trim().toLowerCase();
    const named = types.filter((t) => !!t.selite);
    const exact = named.filter((t) => t.selite.toLowerCase() === q);
    const matches = exact.length > 0 ? exact : named.filter((t) => t.selite.toLowerCase().includes(q));
    if (matches.length === 1)
        return matches[0].sijaintiTypeId;
    const valid = named.map((t) => `${t.sijaintiTypeId}=${t.selite}`).join(", ");
    throw new CliError(matches.length === 0
        ? `Unknown sijainti type "${input}" — valid: ${valid}`
        : `Ambiguous sijainti type "${input}" — matches: ${matches
            .map((t) => t.selite)
            .join(", ")}. Valid: ${valid}`, 0, null, 4);
}
/**
 * `ib sijainti list` orchestrator. Fetches the sijaintiTypes lookup first (it
 * also resolves a type-NAME `--type` to its id), then the list, and joins a
 * human-readable `typeName` onto every row (server-provided typeName wins —
 * newer backends emit it directly).
 *
 * `--search` works on EVERY backend: the query is forwarded server-side
 * (newer backends pre-filter name/street/typeName via LIKE; older ones ignore
 * the param) AND re-applied client-side over a scan of up to the backend cap
 * (500 rows), then sliced to `limit` (default 100). `--all` (scope=all) is
 * server-only — on a backend without it the own+shared scope comes back.
 */
export async function runSijaintiListJoined(client, opts) {
    const types = await runSijaintiTypes(client);
    const typeId = opts.type !== undefined && opts.type !== ""
        ? resolveSijaintiTypeId(types.items, opts.type)
        : undefined;
    const env = await runSijaintiList(client, {
        type: typeId !== undefined ? String(typeId) : undefined,
        limit: opts.search ? SIJAINTI_SEARCH_SCAN_LIMIT : opts.limit,
        validAt: opts.validAt,
        includeDeleted: opts.includeDeleted,
        search: opts.search,
        all: opts.all,
    });
    const selite = new Map(types.items.map((t) => [t.sijaintiTypeId, t.selite]));
    let items = env.items.map((r) => ({
        ...r,
        typeName: r.typeName ?? selite.get(Number(r.type)) ?? null,
    }));
    // Propagate the backend's honest truncation signal (deploy-gated; undefined
    // on older backends) — without it a default-limit scope=all list silently
    // capped at 100 reads as complete. A client-side --search slice that cuts
    // matched rows is truncation too.
    let truncated = env.truncated === true;
    if (opts.search) {
        const matched = items.filter((r) => sijaintiRowMatches(r, opts.search));
        const cap = opts.limit ?? DEFAULT_LIST_LIMIT;
        truncated = truncated || matched.length > cap;
        items = matched.slice(0, cap);
    }
    const out = {
        items,
        nextCursor: null,
        count: items.length,
    };
    if (truncated)
        out.truncated = true;
    return out;
}
/**
 * POST /api/geocode/getLatLng — geocode a free-form address string to
 * coordinates via Google Maps. The backend derives ownerAsiakasId from the
 * token. Returns the raw Google geocode result verbatim (shape:
 * `{ status, lat, lng, ... }`; `{ status: "ZERO_RESULTS" }` when the address
 * is shorter than 5 characters or has no match). Read-only, no write flags.
 */
export async function runSijaintiGeocode(client, address) {
    return client.post("/api/geocode/getLatLng", { osoite: address });
}
/**
 * Resolve the caller's active ownerAsiakasId via the existing
 * /api/company-selection/available route. Used by closest/distance, whose
 * legacy geocode routes still take asiakasId as a URL positional.
 */
async function resolveOwnerAsiakasId(client) {
    const available = await client.get("/api/company-selection/available");
    // Guard the falsy case: the backend derives currentCompanyId from the token's
    // ownerAsiakasId and returns undefined when it is absent. Without this, the
    // value would interpolate into the closest/distance URL as the string
    // "undefined" (→ NaN server-side) and silently return zero results instead of
    // a clear error.
    if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
        throw new Error("could not resolve active company — run `ib auth switch` or pass --asiakas");
    }
    return available.currentCompanyId;
}
/** Backend "nothing found" sentinel distance from getClosestAsiakasSijaintiForTyomaa. */
const NO_CLOSEST_SENTINEL = 999999999;
/**
 * GET /api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa — nearest
 * sijainti of the given type to a worksite (straight-line / Haversine).
 *
 * The legacy route path carries a `:sijaintiId` segment the handler IGNORES —
 * we pass `0`. asiakasId defaults to the caller's active company. The raw
 * response is a createSuccessResponse envelope (matkaM/min/timestamp noise);
 * we project to just `{ closestSijainti, closestDistance }`. The backend
 * reports "no sijainti of this type" as closestSijainti null + distance
 * 999999999 — the sentinel is normalized to null so it is never mistaken
 * for a real distance.
 */
export async function runSijaintiClosest(client, opts) {
    const asiakasId = opts.asiakasId ?? (await resolveOwnerAsiakasId(client));
    const raw = await client.get(`/api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa/${opts.tyomaaId}/0/${opts.sijaintiTypeId}/${asiakasId}`);
    const closestSijainti = raw.closestSijainti ?? null;
    const distance = raw.closestDistance;
    return {
        closestSijainti,
        closestDistance: closestSijainti === null || distance === undefined || distance >= NO_CLOSEST_SENTINEL
            ? null
            : distance,
    };
}
/** Parse a "lat,lng" token into coordinates, or null if it is not that shape. */
function parseCoordToken(token) {
    // Require exactly two non-empty parts so a truncated token like "60.17," is
    // rejected (Number("") is 0, which would otherwise pass as lng=0) and a
    // malformed "60,24,5" doesn't silently drop its tail.
    const parts = token.split(",");
    if (parts.length !== 2)
        return null;
    const [rawA, rawB] = parts.map((x) => x.trim());
    if (!rawA || !rawB)
        return null;
    const a = Number(rawA);
    const b = Number(rawB);
    if (Number.isFinite(a) && Number.isFinite(b))
        return { lat: a, lng: b };
    return null;
}
/**
 * Synchronously validate a distance point token. Returns the coords if it is a
 * "lat,lng" string, returns the integer sijaintiId if it is a bare id, or
 * throws a validation error (caller exits 4) if it is neither.
 */
function parseDistanceToken(token) {
    const coord = parseCoordToken(token);
    if (coord)
        return coord;
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
async function resolveDistancePoint(client, token) {
    const parsed = parseDistanceToken(token);
    if (typeof parsed === "object")
        return parsed;
    const row = (await runSijaintiGet(client, parsed));
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
export async function runSijaintiDistance(client, fromToken, toToken) {
    // Validate tokens synchronously before issuing any network calls so that a
    // malformed token rejects immediately without touching the API.
    parseDistanceToken(fromToken);
    parseDistanceToken(toToken);
    const [from, to, ownerAsiakasId] = await Promise.all([
        resolveDistancePoint(client, fromToken),
        resolveDistancePoint(client, toToken),
        resolveOwnerAsiakasId(client),
    ]);
    const raw = await client.get(`/api/geocode/getDrivingDistance/${from.lat}/${from.lng}/${to.lat}/${to.lng}/${ownerAsiakasId}`);
    return {
        matkaM: raw.matkaM ?? null,
        matkaMin: raw.matkaAika ?? null,
        from,
        to,
    };
}
/**
 * Register `ib sijainti` subcommands on the parent commander instance:
 *   - list      typeName-joined rows; filterable by --type (id or name)/--search/
 *               --limit/--valid-at/--include-deleted
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
export function registerSijaintiCommands(parent, getClient) {
    const s = parent.command("sijainti").description("Sijainti (location) commands");
    s.command("list")
        .description("List sijainti (locations)")
        .option("--type <t>", "Filter by sijaintiTypeId or type name (e.g. betoniasema)")
        .option("--search <text>", "Case-insensitive substring over name/address/typeName (newer backends also pre-filter server-side)")
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .option("--valid-at <date>", "Only sijainnit valid on this date (YYYY-MM-DD or today/yesterday/tomorrow)")
        .option("--include-deleted", "Include soft-deleted sijainnit")
        .option("--all", "Include all companies' sijainnit (supplier plants etc.), not just own + shared")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runSijaintiListJoined(client, {
                type: opts.type,
                search: opts.search,
                limit: opts.limit,
                validAt: opts.validAt ? resolveDate(opts.validAt) : undefined,
                includeDeleted: opts.includeDeleted,
                all: opts.all,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("get <sijaintiId>")
        .description("Get a single sijainti by sijaintiId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runSijaintiGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = s
        .command("create")
        .description("Create a new sijainti (POST /api/geocode/sijainti/add). Required: --name, --type. " +
        "--lyh defaults to --name (≤50 chars), --max-distance to 50, --asiakas to your active company. " +
        "--geocode auto-fills lat/lng from the address when coordinates are not given. " +
        "Use typed flags or --body JSON (typed flags win).")
        .option("--body <json>", "JSON object forwarded as the request body")
        .option("--name <n>", "sijaintiNimi (required)")
        .option("--address <a>", "sijaintiOsoite1 (street)")
        .option("--type <id>", "sijaintiTypeId (required; see `ib sijainti types`)", Number)
        .option("--lat <n>", "Latitude", Number)
        .option("--lng <n>", "Longitude", Number)
        .option("--lyh <s>", "sijaintiLyh — short code/abbreviation (≤50 chars; defaults to --name)")
        .option("--max-distance <n>", "maxDeliveryDistance in km (default 50)", Number)
        .option("--asiakas <id>", "Owner asiakasId (defaults to your active company)", Number)
        .option("--geocode", "Auto-fill lat/lng from the address via Google Maps when coordinates are not given");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
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
                failWith(`create requires: ${missing.join(", ")}`, 4);
            }
            // --geocode: eagerly resolve lat/lng from the address (otherwise the row
            // is created without coordinates and a nightly job backfills them later).
            if (opts.geocode && (body.lat === undefined || body.lat === null || body.lng === undefined || body.lng === null)) {
                const address = typeof body.sijaintiOsoite1 === "string" ? body.sijaintiOsoite1 : "";
                if (!address) {
                    failWith("--geocode requires --address (or sijaintiOsoite1 in --body)", 4);
                }
                const geo = await runSijaintiGeocode(client, address);
                const coords = extractGeocodeLatLng(geo);
                if (!coords) {
                    const status = geo?.status ?? "no match";
                    failWith(`could not geocode address "${address}" (status: ${status})`, 4);
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
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = s
        .command("update")
        .description("Update a sijainti (POST /api/geocode/updateSijainti). sijaintiId via --id or in --body. Typed flags win over --body.")
        .option("--body <json>", "JSON object forwarded as the request body")
        .option("--id <sijaintiId>", "Target sijaintiId", Number)
        .option("--name <n>", "sijaintiNimi")
        .option("--address <a>", "sijaintiOsoite1 (street)")
        .option("--type <id>", "sijaintiTypeId", Number)
        .option("--lat <n>", "Latitude", Number)
        .option("--lng <n>", "Longitude", Number)
        .option("--lyh <s>", "sijaintiLyh — short code/abbreviation (≤50 chars)")
        .option("--max-distance <n>", "maxDeliveryDistance in km", Number);
    addWriteFlagsToCommand(updateCmd).action(async (opts) => {
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
                failWith("update requires sijaintiId — pass --id or include it in --body", 4);
            }
            const result = await runSijaintiUpdate(client, body, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const setJerryCmd = s
        .command("set-jerry <sijaintiId>")
        .description("Enrol/unenrol a varikko in BetoniJerry (--on/--off). BetoniJerry coverage " +
        "keys on the delivery radius maxDeliveryDistance (KM) — NOT geofenceRadius " +
        "(metres, a GPS depot detector) — so --on also sets that radius: --radius " +
        "<km>, or a 50 km default when the varikko has none (otherwise it would be " +
        "enrolled but cover nothing). Also requires the company's isPumppuToimittaja " +
        "flag AND HAS_JERRY setting (ib jerry admin enable).")
        .option("--on", "Enrol: jerryActiveUntil = sentinel + ensure a delivery radius")
        .option("--off", "Unenrol: jerryActiveUntil = null")
        .option("--radius <km>", "Delivery radius in km (maxDeliveryDistance) to set when enrolling", Number);
    addWriteFlagsToCommand(setJerryCmd).action(async (idStr, opts) => {
        if (opts.on === opts.off) {
            // neither or both given — ambiguous
            failWith("Pass exactly one of --on / --off", 4);
        }
        if (opts.radius !== undefined && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
            failWith("--radius must be a positive number of km", 4);
        }
        try {
            const client = await getClient();
            const result = await runSijaintiSetJerry(client, Number(idStr), !!opts.on, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }, opts.radius);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(s
        .command("delete <sijaintiId>")
        .description("Soft-delete a sijainti (DELETE /api/geocode/sijainti/delete/:id). Requires --reason.")).action(async (idStr, opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const client = await getClient();
            const result = await runSijaintiDelete(client, Number(idStr), opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(s
        .command("undelete <sijaintiId>")
        .description("Restore a soft-deleted sijainti (POST /api/geocode/sijainti/undelete/:id). Requires --reason.")).action(async (idStr, opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const client = await getClient();
            const result = await runSijaintiUndelete(client, Number(idStr), opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("types")
        .description("List sijainti type categories (the 'Sijainnin laji' lookup; maps sijaintiTypeId → selite)")
        .option("--jerry", "Use the BetoniJerry sijainti type set")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runSijaintiTypes(client, opts.jerry);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("geocode")
        .description("Geocode an address string to coordinates (POST /api/geocode/getLatLng, Google Maps)")
        .requiredOption("--address <a>", "Free-form address to geocode")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runSijaintiGeocode(client, opts.address);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("closest")
        .description("Find the closest sijainti of a given type to a worksite (straight-line distance)")
        .option("--worksite <id>", "Target tyomaaId (same flag as the rest of the CLI)", Number)
        .option("--tyomaa <id>", "Target tyomaaId (Finnish alias of --worksite)", Number)
        .requiredOption("--type <id>", "sijaintiTypeId to search within", Number)
        .option("--asiakas <id>", "Owner asiakasId (defaults to active company)", Number)
        .action(async (opts) => {
        try {
            const client = await getClient();
            if (opts.worksite !== undefined && opts.tyomaa !== undefined && opts.worksite !== opts.tyomaa) {
                failWith("--worksite and --tyomaa differ — pass only one", 4);
            }
            const tyomaaId = opts.worksite ?? opts.tyomaa;
            if (tyomaaId === undefined) {
                failWith("missing target: pass --worksite <id> (--tyomaa is accepted as an alias)", 4);
            }
            const result = await runSijaintiClosest(client, {
                tyomaaId,
                sijaintiTypeId: opts.type,
                asiakasId: opts.asiakas,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("distance")
        .description("Driving distance/time between two points (each is 'lat,lng' or a sijaintiId)")
        .requiredOption("--from <point>", "Origin: 'lat,lng' or a sijaintiId")
        .requiredOption("--to <point>", "Destination: 'lat,lng' or a sijaintiId")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runSijaintiDistance(client, opts.from, opts.to);
            writeJson(result);
        }
        catch (e) {
            // A bad point token is a validation error (exit 4); API/network errors
            // keep their contract-mapped codes via exitWithError.
            if (e instanceof Error &&
                (e.message.startsWith("invalid point") ||
                    e.message.includes("has no coordinates"))) {
                failWith(errorMessage(e), 4);
            }
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map