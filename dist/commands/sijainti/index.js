import { listEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, failWith, errorMessage } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { CliError } from "../../api/errors.js";
import { parseId, cappedInt, assertPositiveInt, intFlag, numFlag } from "../../targets.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { flattenGeocodeResult } from "../_shared/geocode.js";
import { runAddressDashboard, registerDashboardCommand, } from "../_shared/addressDashboard.js";
import { qs } from "../../api/query.js";
import { bothInOrder } from "../../parallel.js";
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
    if (typed.puomiMin !== undefined)
        body.puomiMin = typed.puomiMin;
    if (typed.puomiMax !== undefined)
        body.puomiMax = typed.puomiMax;
    // Only when the flag was actually given. An absent isPublic must stay absent
    // all the way to sijainti_save, whose COALESCE(@isPublic, isPublic) then keeps
    // the stored value — sending `false` by default would silently unpublish a
    // supplier's plant on any unrelated `--nimi` edit.
    if (typed.public !== undefined)
        body.isPublic = typed.public;
    return body;
}
/**
 * Largest boom the DB can store: `sijainti.puomiMin`/`puomiMax` are DECIMAL(5,2),
 * so 999.99 m is the hard ceiling. Mirrors the server's `validatePuomiRange`
 * (geocode.js) `v > 999.99 → 400` — kept in sync so the client rejects the same
 * range the backend would, one round-trip earlier.
 */
const PUOMI_MAX_M = 999.99;
/**
 * Guard the `--puomi-min`/`--puomi-max` flag pair (metres). Each must be a finite
 * number in 0–999.99 when supplied, and min must not exceed max; otherwise exit 4.
 * Without this, a typo like `--puomi-min 3O` makes Commander coerce `Number("3O")`
 * → `NaN`, which serializes to JSON `null` and silently CLEARS a stored bound on
 * the server (the save proc assigns puomiMin directly, no COALESCE); and an
 * out-of-range value like `--puomi-min 1500` would only be caught after a wasted
 * round-trip (server 400) or overflow the DECIMAL(5,2) column. This mirrors the
 * server's `validatePuomiRange` exactly. Shared by `sijainti create`, `sijainti
 * update`, and `set-jerry` so all three reject bad input identically.
 */
export function assertPuomiFlags(puomiMin, puomiMax) {
    for (const [flag, v] of [
        ["--puomi-min", puomiMin],
        ["--puomi-max", puomiMax],
    ]) {
        if (v === undefined)
            continue;
        if (!Number.isFinite(v) || v < 0) {
            failWith(`${flag} must be a non-negative number of metres`, 4);
        }
        if (v > PUOMI_MAX_M) {
            failWith(`${flag} cannot exceed ${PUOMI_MAX_M} metres`, 4);
        }
    }
    if (puomiMin !== undefined && puomiMax !== undefined && puomiMin > puomiMax) {
        failWith("--puomi-min cannot exceed --puomi-max", 4);
    }
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
 * Is a list row's BetoniJerry enrolment ACTIVE right now? True when
 * `jerryActiveUntil` is non-null AND parses to a moment >= `now` (future/sentinel
 * = active; a PAST date = expired = inactive). The stored value is Helsinki-local
 * without a timezone (e.g. "9999-12-31 23:59:59" sentinel, or a real date) — a
 * near-expiry boundary can be off by the TZ offset, acceptable for an audit
 * heuristic. Pure (takes `now`) so it is directly unit-testable.
 */
export function sijaintiJerryActive(row, now) {
    const raw = row.jerryActiveUntil;
    if (raw == null)
        return false;
    const until = new Date(String(raw));
    return Number.isFinite(until.getTime()) && until.getTime() >= now.getTime();
}
/**
 * Derived `matchable` for a list row (fb#108): the full set BetoniJerry needs
 * to match a varikko to a delivery — enrolment ACTIVE ({@link sijaintiJerryActive})
 * AND GPS coords present AND a positive delivery radius (maxDeliveryDistance km).
 * A row that is Jerry-active but has null coords or a 0/null radius covers
 * nothing, so `matchable:false` flags the misconfiguration. Boom range
 * (puomiMin/puomiMax) is deliberately NOT part of this — it is optional
 * (NULL = unbounded) and stays off the list. Pure (takes `now`).
 */
export function sijaintiMatchable(row, now) {
    return (sijaintiJerryActive(row, now) &&
        row.coords != null &&
        Number(row.maxDeliveryDistance) > 0);
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
    return client.get(`/api/cli/sijainti/list${qs({
        type: opts.type || undefined,
        limit: opts.limit,
        validAtDate: opts.validAt || undefined,
        includeDeleted: opts.includeDeleted ? "1" : undefined,
        search: opts.search || undefined,
        scope: opts.all ? "all" : undefined,
    })}`);
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
 * Build the full save body for an update: the current row with the sparse
 * user-supplied fields overlaid (fb#93). lat/lng/placeId are stripped from the
 * base — the save proc binds none of them (they are persisted separately via
 * updateLatLng) and re-sending the old coords under a changed address would
 * resurrect stale coordinates. An explicit null in `sparse` still clears its
 * field; the server-side extractSijaintiBody whitelist drops any extra keys.
 */
export function mergeSijaintiUpdateBody(current, sparse) {
    const base = { ...current };
    delete base.lat;
    delete base.lng;
    delete base.placeId;
    return { ...base, ...sparse };
}
/** Did the sparse update change an address line? (null/undefined normalised) */
export function sijaintiAddressChanged(current, sparse) {
    return ["sijaintiOsoite1", "sijaintiOsoite2"].some((k) => sparse[k] !== undefined && (sparse[k] ?? null) !== (current[k] ?? null));
}
/**
 * Update a sijainti via read-merge-write (fb#93). The `sijainti_save` proc
 * assigns most columns directly (no COALESCE) — a sparse body would NULL
 * jerryActiveUntil (silently unenrolling a Jerry varikko), start/end dates,
 * phone and comment — so the current row is fetched first and the sparse
 * `body` overlaid on it (same GET+merge as set-jerry). The proc also NULLs
 * lat/lng/placeId whenever an address line changes, so an address change
 * without explicit coords geocodes the new address automatically (soft-fail:
 * `geocodeFailed` is reported on the outcome instead of aborting the update);
 * `geocode=true` (--geocode) forces re-resolution and fails fast. The target
 * `sijaintiId` is carried IN the body (geocodeRoutes.js shape).
 */
export async function runSijaintiUpdate(client, body, flags, geocode = false) {
    const current = await runSijaintiGet(client, Number(body.sijaintiId));
    const merged = mergeSijaintiUpdateBody(current, body);
    let geocodeFailed;
    if (geocode) {
        await applyGeocodeToBody(client, merged); // explicit: fail fast on a bad address
    }
    else if (sijaintiAddressChanged(current, body) &&
        merged.lat == null &&
        merged.lng == null) {
        try {
            await applyGeocodeToBody(client, merged);
        }
        catch (e) {
            geocodeFailed = errorMessage(e);
        }
    }
    const result = await client.post("/api/geocode/updateSijainti", merged, {
        headers: writeFlagsToHeaders(flags),
    });
    return { result, merged, geocodeFailed };
}
/**
 * POST /api/geocode/updateLatLng/:sijaintiId — persist a sijainti's coordinates.
 * The `sijainti_add` / `sijainti_save` procs bind NO lat/lng, so the add/update
 * routes silently drop coordinates; this is the dedicated route the FE
 * EditSijainti calls right after create/update for exactly that reason
 * (puminet4 EditSijainti.jsx → saveLatLng). No placeId is sent (matching the
 * FE), so a manual/CLI coordinate write never fabricates a Google place_id.
 */
export async function runSijaintiSaveLatLng(client, sijaintiId, lat, lng, flags) {
    return client.post(`/api/geocode/updateLatLng/${sijaintiId}`, { lat, lng }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * After a create/update whose proc dropped the coordinates, persist them via
 * {@link runSijaintiSaveLatLng} (the FE's create→saveLatLng flow) and return the
 * result echo with `{ lat, lng, coordsPersisted }` attached — so geocoding
 * success is verifiable without a follow-up read. No coords / a dry-run / no
 * resolved sijaintiId → the coords are echoed but `coordsPersisted:false` and no
 * write is issued (dry-run stays write-free; works under --read-only's GET-only
 * lock only when not actually persisting). Coords coerced from the (possibly
 * string) body values; only a finite lat AND lng trigger persistence.
 */
export async function persistSijaintiCoords(client, result, sijaintiId, coords, flags) {
    const lat = Number(coords.lat);
    const lng = Number(coords.lng);
    const hasCoords = coords.lat != null &&
        coords.lng != null &&
        Number.isFinite(lat) &&
        Number.isFinite(lng);
    if (!hasCoords)
        return result;
    const base = result && typeof result === "object" ? { ...result } : {};
    if (flags.dryRun || !sijaintiId)
        return { ...base, lat, lng, coordsPersisted: false };
    await runSijaintiSaveLatLng(client, sijaintiId, lat, lng, flags);
    return { ...base, lat, lng, coordsPersisted: true };
}
/**
 * --geocode: resolve lat/lng from the body's address (sijaintiOsoite1) and set
 * them on the body, unless coordinates are already present. Shared by create
 * and update (the procs bind no lat/lng — persistSijaintiCoords then writes them
 * via updateLatLng). Fails fast (exit 4) when no address is given or the address
 * has no match (ZERO_RESULTS), so a bad address never silently persists without
 * coordinates. Mutates `body`.
 */
export async function applyGeocodeToBody(client, body) {
    if (body.lat !== undefined &&
        body.lat !== null &&
        body.lng !== undefined &&
        body.lng !== null) {
        return;
    }
    const address = typeof body.sijaintiOsoite1 === "string" ? body.sijaintiOsoite1 : "";
    if (!address) {
        failWith("--geocode requires --address (or sijaintiOsoite1 in --body)", 4);
    }
    // runSijaintiGeocode already flattens, so the coordinates are read straight
    // off the result — no second extraction pass.
    const geo = await runSijaintiGeocode(client, address);
    if (!geo.geocoded) {
        failWith(`could not geocode address "${address}" (status: ${geo.status ?? "no match"})`, 4);
    }
    body.lat = geo.lat;
    body.lng = geo.lng;
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
export async function runSijaintiSetJerry(client, sijaintiId, on, flags, radius, boom) {
    return patchSijainti(client, sijaintiId, flags, (current) => {
        const patch = {
            jerryActiveUntil: on ? JERRY_ACTIVE_SENTINEL : null,
        };
        if (on) {
            if (radius !== undefined) {
                patch.maxDeliveryDistance = radius;
            }
            else if (!Number(current.maxDeliveryDistance)) {
                patch.maxDeliveryDistance = DEFAULT_JERRY_RADIUS_KM;
            }
        }
        // Per-sijainti boom range (m) — the betonijerry matching filter since
        // 2026-07 (vehicle fleet booms are no longer consulted). Only set when
        // given; the GET+merge otherwise preserves the stored bounds.
        if (boom?.min !== undefined)
            patch.puomiMin = boom.min;
        if (boom?.max !== undefined)
            patch.puomiMax = boom.max;
        return patch;
    });
}
/**
 * Read-merge-write against /api/geocode/updateSijainti: GET the current flat
 * record, overlay `patch(current)`, POST the merged body. set-jerry and
 * set-public both go through here — there is no partial-update route, and
 * sijainti_save assigns most columns directly, so a sparse body would NULL the
 * untouched fields. (runSijaintiUpdate has its own merge on purpose: it must
 * also strip lat/lng/placeId.)
 */
async function patchSijainti(client, sijaintiId, flags, patch) {
    const current = await runSijaintiGet(client, sijaintiId);
    const body = { ...current, sijaintiId, ...patch(current) };
    return client.post("/api/geocode/updateSijainti", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Publish/unpublish a sijainti (dbo.sijainti.isPublic).
 *
 * `isPublic = 1` means readable by EVERY authenticated user of EVERY tenant —
 * that is what lets the keikka flow fetch a supplier's concrete plants — so this
 * is a cross-tenant exposure control, not a display preference. The backend
 * requires company-admin (or sysadmin/developer) rights to CHANGE it and refuses
 * on --dry-run too, so an unauthorized caller gets exit 3 rather than a
 * misleading successful preview.
 *
 * Same GET+merge as set-jerry, and for the same reason: there is no partial
 * update route, and `sijainti_save` assigns most columns directly, so a sparse
 * body would NULL jerryActiveUntil, the dates, phone and comment. Going through
 * /api/geocode/updateSijainti is also load-bearing for CACHE correctness — that
 * route carries the SIJAINTI_UPDATE invalidation whose wildcard sweep of
 * geocode:sijaintiList:* / geocode:closest:* is what stops a list cached while
 * the row was public from being served after it is made private. A dedicated
 * "set visibility" endpoint would bypass that and reopen the stale-cache leak.
 */
export async function runSijaintiSetPublic(client, sijaintiId, on, flags) {
    return patchSijainti(client, sijaintiId, flags, () => ({ isPublic: on }));
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
        // BIT column: node-mssql yields a boolean, but tolerate a raw 0/1 the way
        // OhjeRecord.needsHumanReview does.
        useJerry: r.useJerry === true || r.useJerry === 1,
    }));
    return listEnvelope(items);
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
/**
 * The lookup-free fast path of {@link resolveSijaintiTypeId}: a positive-integer
 * literal IS the id. `undefined` means the value is a NAME and needs the
 * sijaintiTypes lookup — the one case `runSijaintiListJoined` must stay sequential.
 */
function numericTypeId(input) {
    const n = Number(input);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}
export function resolveSijaintiTypeId(
// Declares only the two fields it reads, rather than the whole row: adding
// `useJerry` to SijaintiTypeItem (fb#608) would otherwise have forced every
// name-resolution fixture to carry a field this function never looks at.
types, input) {
    const passthrough = numericTypeId(input);
    if (passthrough !== undefined)
        return passthrough;
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
 * `owner` (--asiakas) is a client-side filter on `ownerAsiakasId` and uses the
 * same scan-then-slice path as `search`.
 *
 * An EMPTY result without `all` carries a `hint` pointing at `--all` and
 * `--all --asiakas <id>` (feedback #30/#133): supplier sijainnit belong to
 * other companies and are invisible in the default scope, so "0 rows" alone
 * reads as "does not exist".
 */
export async function runSijaintiListJoined(client, opts) {
    const clientFiltered = !!opts.search || opts.owner !== undefined || !!opts.jerry || opts.public !== undefined;
    const list = (typeId) => runSijaintiList(client, {
        type: typeId !== undefined ? String(typeId) : undefined,
        limit: clientFiltered ? SIJAINTI_SEARCH_SCAN_LIMIT : opts.limit,
        validAt: opts.validAt,
        includeDeleted: opts.includeDeleted,
        search: opts.search,
        all: opts.all,
    });
    const rawType = opts.type !== undefined && opts.type !== "" ? opts.type : undefined;
    // Only a --type NAME needs the types lookup to build the list query; with no
    // --type (or a numeric one) the two reads are independent, so issue them together.
    const knownTypeId = rawType === undefined ? undefined : numericTypeId(rawType);
    let types;
    let env;
    if (rawType !== undefined && knownTypeId === undefined) {
        types = await runSijaintiTypes(client);
        env = await list(resolveSijaintiTypeId(types.items, rawType));
    }
    else {
        [types, env] = await bothInOrder(runSijaintiTypes(client), list(knownTypeId));
    }
    const selite = new Map(types.items.map((t) => [t.sijaintiTypeId, t.selite]));
    let items = env.items.map((r) => ({
        ...r,
        typeName: r.typeName ?? selite.get(Number(r.type)) ?? null,
    }));
    // Propagate the backend's honest truncation signal (deploy-gated; undefined
    // on older backends) — without it a default-limit scope=all list silently
    // capped at 100 reads as complete. A client-side --search/--asiakas/--jerry
    // slice that cuts matched rows is truncation too.
    let truncated = env.truncated === true;
    if (clientFiltered) {
        let matched = items;
        if (opts.owner !== undefined) {
            matched = matched.filter((r) => Number(r.ownerAsiakasId) === opts.owner);
        }
        if (opts.search) {
            matched = matched.filter((r) => sijaintiRowMatches(r, opts.search));
        }
        if (opts.jerry) {
            // --jerry (fb#108): keep only Jerry-ENROLLED rows (jerryActiveUntil set;
            // expired kept so lapsed varikot surface) and stamp each with `matchable`.
            const now = new Date();
            matched = matched
                .filter((r) => r.jerryActiveUntil != null)
                .map((r) => ({ ...r, matchable: sijaintiMatchable(r, now) }));
        }
        if (opts.public !== undefined) {
            // Coerced, not identity-compared: the field arrives as a JSON boolean from
            // the CLI route but as 1/0 from anything reading the column raw.
            matched = matched.filter((r) => !!r.isPublic === opts.public);
        }
        const cap = opts.limit ?? DEFAULT_LIST_LIMIT;
        truncated = truncated || matched.length > cap;
        items = matched.slice(0, cap);
    }
    const out = listEnvelope(items);
    if (truncated)
        out.truncated = true;
    if (items.length === 0 && !opts.all) {
        out.hint =
            "0 rows in the default own+shared scope — supplier locations (betoniasemat, depots) belong to OTHER companies; retry with --all to search every company's sijainnit, or --all --asiakas <id> when you know the owner company";
    }
    return out;
}
/**
 * `ib sijainti plants` (alias `tehtaat`) — concrete plants (type Betoniasema)
 * across ALL companies. Sugar for `sijainti list --type betoniasema --all`:
 * plants overwhelmingly belong to supplier companies (Rudus, Lujabetoni, …),
 * so the own+shared default scope would hide nearly all of them. The type is
 * resolved by NAME through the sijaintiTypes lookup (not a hardcoded id).
 * `asiakas` narrows to one company's plants (client-side on ownerAsiakasId).
 */
export async function runSijaintiPlants(client, opts) {
    return runSijaintiListJoined(client, {
        type: "betoniasema",
        all: true,
        owner: opts.asiakas,
        search: opts.search,
        limit: opts.limit,
    });
}
/**
 * POST /api/geocode/getLatLng — geocode a free-form address string to
 * coordinates via Google Maps. The backend derives ownerAsiakasId from the
 * token.
 *
 * Returns the FLAT `{ geocoded, lat, lng, placeId, formattedAddress }` summary
 * that `ib jerry check-address` also returns (feedback #317 — the two entry
 * points used to disagree, so a parser written against one silently produced
 * undefined,undefined from the other), with `status` and the raw `results[]`
 * retained alongside. No match → `geocoded:false`, exit 0 — same as
 * check-address; the address not existing is an answer, not an error.
 *
 * Marked `read: true`: it is a POST only because the address travels in the
 * body, so it must not trip the `--read-only` write-lock or the acting-as write
 * banner (and it IS retryable on a network blip).
 */
export async function runSijaintiGeocode(client, address) {
    const geo = await client.post("/api/geocode/getLatLng", { osoite: address }, { read: true });
    const raw = geo;
    return {
        ...flattenGeocodeResult(geo),
        // Google's status when it answered; otherwise the backend's own errorCode
        // envelope (TEST_ADDRESS / GOOGLE_MAPS_TIMEOUT / …), which carries no
        // `status` — without this a service failure is indistinguishable from
        // "address not found", both arriving as a bare geocoded:false.
        status: typeof raw?.status === "string"
            ? raw.status
            : typeof raw?.errorCode === "string"
                ? raw.errorCode
                : null,
        results: Array.isArray(raw?.results) ? raw.results : [],
    };
}
/**
 * Resolve the caller's active ownerAsiakasId. Used by closest/distance, whose
 * legacy geocode routes still take asiakasId as a URL positional — the shared
 * resolver's guard prevents `undefined` interpolating into those URLs.
 */
async function resolveOwnerAsiakasId(client) {
    return resolveActiveOwnerAsiakasId(client, "run `ib auth switch` or pass --asiakas");
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
 * exits 4 if it is neither.
 */
function parseDistanceToken(token) {
    const coord = parseCoordToken(token);
    if (coord)
        return coord;
    const id = Number(token);
    if (!Number.isInteger(id) || id <= 0) {
        failWith(`invalid point '${token}' — use 'lat,lng' or a sijaintiId`, 4);
    }
    return id;
}
/**
 * Resolve a parsed distance endpoint ({lat,lng} passes through; a sijaintiId is
 * resolved via runSijaintiGet → its lat/lng). Exits 4 on a sijainti with no
 * coordinates.
 */
async function resolveDistancePoint(client, parsed) {
    if (typeof parsed === "object")
        return parsed;
    const row = (await runSijaintiGet(client, parsed));
    if (typeof row.lat !== "number" || typeof row.lng !== "number") {
        failWith(`sijainti ${parsed} has no coordinates`, 4);
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
    // Both tokens parse synchronously before any network call, so a malformed
    // token rejects immediately without touching the API.
    const [parsedFrom, parsedTo] = [fromToken, toToken].map(parseDistanceToken);
    const [from, to, ownerAsiakasId] = await Promise.all([
        resolveDistancePoint(client, parsedFrom),
        resolveDistancePoint(client, parsedTo),
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
 * Fail fast (exit 4) on a non-numeric / non-positive `--asiakas` value —
 * Commander's Number coercion would otherwise turn it into NaN, which the
 * client-side owner filter silently matches against nothing.
 */
function assertValidAsiakasFlag(asiakas) {
    if (asiakas !== undefined)
        assertPositiveInt(asiakas, "--asiakas");
}
/**
 * `ib sijainti dashboard` — resolve the caller's point from exactly one of
 * `sijaintiId` / `address` and delegate to the shared
 * {@link runAddressDashboard} orchestrator (Address Information Dashboard,
 * spec 2026-07-01): weather, building, cadastral parcel, nearby traffic
 * cameras, nearby sijainnit, worksite deliveries, and nearby vehicles merged
 * into one report. The exactly-one validation is the caller's job (the
 * command action, mirroring `ib opendata building`'s `selectedSources`
 * pattern) — this function just forwards whichever one is set.
 */
export async function runSijaintiDashboard(client, opts) {
    return runAddressDashboard(client, opts.address !== undefined ? { address: opts.address } : { sijaintiId: opts.sijaintiId });
}
/**
 * Register `ib sijainti` subcommands on the parent commander instance:
 *   - list      typeName-joined rows; filterable by --type (id or name)/--search/
 *               --limit/--valid-at/--include-deleted/--asiakas (owner)
 *   - plants    (alias: tehtaat) concrete plants (betoniasemat) across ALL
 *               companies; --asiakas narrows to one company's plants
 *   - get       single sijainti by id (existing /api/geocode/sijainti route)
 *   - dashboard one-shot Address Information Dashboard report (read-only)
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
        .option("--type <t>")
        .option("--search <text>")
        .option("--limit <n>", "", cappedInt(500))
        .option("--valid-at <date>")
        .option("--include-deleted")
        .option("--all")
        .option("--asiakas <id>", "", Number)
        .option("--jerry")
        .option("--public")
        .option("--private")
        .action(guarded(async (opts) => {
        assertValidAsiakasFlag(opts.asiakas);
        // Two flags rather than Commander's --no-public: declaring a negated
        // option defaults the value to TRUE, which would silently turn "no
        // filter" into "published only".
        if (opts.public && opts.private) {
            failWith("Pass at most one of --public / --private", 4);
        }
        const client = await getClient();
        const result = await runSijaintiListJoined(client, {
            type: opts.type,
            search: opts.search,
            limit: opts.limit,
            validAt: opts.validAt ? resolveDate(opts.validAt) : undefined,
            includeDeleted: opts.includeDeleted,
            all: opts.all,
            owner: opts.asiakas,
            jerry: opts.jerry,
            public: opts.public ? true : opts.private ? false : undefined,
        });
        writeJson(result);
    }));
    s.command("plants")
        .alias("tehtaat")
        .option("--asiakas <id>", "", Number)
        .option("--search <text>")
        .option("--limit <n>", "", cappedInt(500))
        .action(guarded(async (opts) => {
        assertValidAsiakasFlag(opts.asiakas);
        const client = await getClient();
        const result = await runSijaintiPlants(client, {
            asiakas: opts.asiakas,
            search: opts.search,
            limit: opts.limit,
        });
        writeJson(result);
    }));
    s.command("get <sijaintiId>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .action(jsonAction(getClient, (client, idStr) => runSijaintiGet(client, parseId(idStr, "sijaintiId"))));
    registerDashboardCommand(s, getClient, {
        idArg: "sijaintiId",
        addressDescription: "Resolve the point from a street address instead of sijaintiId",
        run: (client, sijaintiId, address) => runSijaintiDashboard(client, { sijaintiId, address }),
    });
    const createCmd = s
        .command("create")
        .option("--body <json>")
        .option("--name <n>")
        .option("--address <a>")
        .option("--type <id>", "", intFlag("--type"))
        .option("--lat <n>", "", numFlag("--lat"))
        .option("--lng <n>", "", numFlag("--lng"))
        .option("--lyh <s>")
        .option("--max-distance <n>", "", numFlag("--max-distance"))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .option("--puomi-min <m>", "", Number)
        .option("--puomi-max <m>", "", Number)
        .option("--public")
        .option("--geocode");
    addWriteFlagsToCommand(createCmd).action(guarded(async (opts) => {
        assertPuomiFlags(opts.puomiMin, opts.puomiMax);
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
            puomiMin: opts.puomiMin,
            puomiMax: opts.puomiMax,
            // Opt-in only. A new row defaults PRIVATE server-side, and the CLI
            // deliberately does NOT infer publicity from `--type betoniasema` —
            // publishing is always an explicit act by a caller entitled to it.
            public: opts.public,
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
        // --geocode: resolve lat/lng from the address up front so the coords can
        // be persisted (the add proc itself binds no lat/lng — see
        // persistSijaintiCoords) and a ZERO_RESULTS address fails fast here.
        if (opts.geocode)
            await applyGeocodeToBody(client, body);
        const result = await runSijaintiCreate(client, body, opts);
        // The add proc drops lat/lng; persist them via the dedicated updateLatLng
        // route (the FE's create→saveLatLng flow) and echo { lat, lng, coordsPersisted }.
        const newId = !opts.dryRun
            ? result?.sijaintiId
            : undefined;
        writeJson(await persistSijaintiCoords(client, result, newId, { lat: body.lat, lng: body.lng }, opts));
    }));
    const updateCmd = s
        .command("update")
        .option("--body <json>")
        .option("--id <sijaintiId>", "", intFlag("--id"))
        .option("--name <n>")
        .option("--address <a>")
        .option("--type <id>", "", intFlag("--type"))
        .option("--lat <n>", "", numFlag("--lat"))
        .option("--lng <n>", "", numFlag("--lng"))
        .option("--lyh <s>")
        .option("--max-distance <n>", "", numFlag("--max-distance"))
        .option("--puomi-min <m>", "", Number)
        .option("--puomi-max <m>", "", Number)
        .option("--public")
        .option("--private")
        .option("--geocode");
    addWriteFlagsToCommand(updateCmd).action(guarded(async (opts) => {
        assertPuomiFlags(opts.puomiMin, opts.puomiMax);
        if (opts.public && opts.private) {
            failWith("Pass at most one of --public / --private", 4);
        }
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
            puomiMin: opts.puomiMin,
            puomiMax: opts.puomiMax,
            // Neither flag = field absent = the stored value survives the
            // read-merge-write. Changing it requires company-admin server-side.
            public: opts.public ? true : opts.private ? false : undefined,
        });
        if (body.sijaintiId === undefined) {
            failWith("update requires sijaintiId — pass --id or include it in --body", 4);
        }
        const { result, merged, geocodeFailed } = await runSijaintiUpdate(client, body, opts, !!opts.geocode);
        // The save proc drops lat/lng; persist them via the dedicated updateLatLng
        // route (the FE's update→saveLatLng flow) and echo { lat, lng, coordsPersisted }.
        const sijaintiId = !opts.dryRun ? Number(body.sijaintiId) : undefined;
        const echo = await persistSijaintiCoords(client, result, sijaintiId, { lat: merged.lat, lng: merged.lng }, opts);
        if (geocodeFailed) {
            const base = echo && typeof echo === "object"
                ? echo
                : { result: echo };
            writeJson({ ...base, coordsPersisted: false, geocodeFailed });
        }
        else {
            writeJson(echo);
        }
    }));
    const setJerryCmd = s
        .command("set-jerry <sijaintiId>")
        .option("--on")
        .option("--off")
        .option("--radius <km>", "", Number)
        .option("--puomi-min <m>", "", Number)
        .option("--puomi-max <m>", "", Number);
    addWriteFlagsToCommand(setJerryCmd).action(guarded(async (idStr, opts) => {
        if (opts.on === opts.off) {
            // neither or both given — ambiguous
            failWith("Pass exactly one of --on / --off", 4);
        }
        if (opts.radius !== undefined && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
            failWith("--radius must be a positive number of km", 4);
        }
        assertPuomiFlags(opts.puomiMin, opts.puomiMax);
        const client = await getClient();
        const result = await runSijaintiSetJerry(client, parseId(idStr, "sijaintiId"), !!opts.on, opts, opts.radius, opts.puomiMin !== undefined || opts.puomiMax !== undefined
            ? { min: opts.puomiMin, max: opts.puomiMax }
            : undefined);
        writeJson(result);
    }));
    const setPublicCmd = s
        .command("set-public <sijaintiId>")
        .option("--on")
        .option("--off");
    addWriteFlagsToCommand(setPublicCmd).action(guarded(async (idStr, opts) => {
        if (opts.on === opts.off) {
            // neither or both given — ambiguous. Never guess on a visibility flip.
            failWith("Pass exactly one of --on / --off", 4);
        }
        const client = await getClient();
        const result = await runSijaintiSetPublic(client, parseId(idStr, "sijaintiId"), !!opts.on, opts);
        writeJson(result);
    }));
    // delete / undelete are the same registration — one <sijaintiId>, write flags,
    // --reason required. Only the run fn differs.
    for (const [name, run] of [
        ["delete", runSijaintiDelete],
        ["undelete", runSijaintiUndelete],
    ]) {
        addWriteFlagsToCommand(s.command(`${name} <sijaintiId>`)).action(guarded(async (idStr, opts) => {
            const client = await getClient();
            writeJson(await run(client, parseId(idStr, "sijaintiId"), opts));
        }));
    }
    s.command("types")
        .option("--jerry")
        .action(jsonAction(getClient, (client, opts) => runSijaintiTypes(client, opts.jerry)));
    s.command("geocode")
        .requiredOption("--address <a>")
        .action(jsonAction(getClient, (client, opts) => runSijaintiGeocode(client, opts.address)));
    // Every flag here is intFlag, not a bare `Number`: all four are interpolated
    // into a URL PATH segment (runSijaintiClosest). --asiakas is the subtle one —
    // it defaults via `?? resolveOwnerAsiakasId()`, and NaN is not nullish, so a
    // typo would survive the default and land in the last segment (fb#371).
    s.command("closest")
        .option("--worksite <id>", "", intFlag("--worksite"))
        .option("--tyomaa <id>", "", intFlag("--tyomaa"))
        .requiredOption("--type <id>", "", intFlag("--type"))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .action(guarded(async (opts) => {
        // Argv guards run BEFORE getClient(): a caller who named the target
        // wrong should be told THAT, not "Not logged in". The ordering was also
        // silently environment-dependent — with credentials present the guard
        // was reached and emitted its remedy, without them getClient() failed
        // first, so parse-errors.test.ts passed on a developer machine and
        // failed in CI (which has no token) on every run.
        if (opts.worksite !== undefined && opts.tyomaa !== undefined && opts.worksite !== opts.tyomaa) {
            failWith("--worksite and --tyomaa differ — pass only one", 4);
        }
        const tyomaaId = opts.worksite ?? opts.tyomaa;
        if (tyomaaId === undefined) {
            failWith("missing target: pass --worksite <id> (--tyomaa is accepted as an alias)", 4);
        }
        const client = await getClient();
        const result = await runSijaintiClosest(client, {
            tyomaaId,
            sijaintiTypeId: opts.type,
            asiakasId: opts.asiakas,
        });
        writeJson(result);
    }));
    s.command("distance")
        .requiredOption("--from <point>")
        .requiredOption("--to <point>")
        .action(jsonAction(getClient, (client, opts) => runSijaintiDistance(client, opts.from, opts.to)));
}
//# sourceMappingURL=index.js.map