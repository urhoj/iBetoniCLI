import { listEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { todayHelsinki } from "../../dates.js";
import { parseJsonBodyFlag, resolveJsonObjectBody } from "../../api/parseBody.js";
import { registerLogAlias } from "../log/index.js";
import { resolveTarget, parseId, resolveSearchQuery, cappedInt, queryAliasOption } from "../../targets.js";
import { runAddressDashboard, registerDashboardCommand, } from "../_shared/addressDashboard.js";
import { runCombinatorDuplicates, runCombinatorMerge, registerCombinatorCommands, } from "../_shared/combinator.js";
import { registerPersonLinkCommands } from "../_shared/personLink.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
/**
 * GET /api/cli/worksite/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runWorksiteList(client, opts) {
    return client.get(`/api/cli/worksite/list${qs({
        limit: opts.limit,
        cursor: opts.cursor || undefined,
        customer: opts.customer,
    })}`);
}
/**
 * GET /api/cli/worksite/get/:tyomaaId. Returns the flat, enriched backend
 * record as-is (every user-relevant field in camelCase; see the spec for the
 * shape). The two heavy JSON blobs are opt-in: `includeBuilding` →
 * `?includeBuilding` (attaches `rakennusData`), `includeCameras` →
 * `?includeCameras` (attaches `cameras[]`). Omitted by default — the lean
 * record still carries `cameraCount` + `hasBuildingData` presence signals.
 */
export async function runWorksiteGet(client, tyomaaId, opts = {}) {
    return client.get(`/api/cli/worksite/get/${tyomaaId}${qs({
        includeBuilding: opts.includeBuilding ? "1" : undefined,
        includeCameras: opts.includeCameras ? "1" : undefined,
    })}`);
}
/**
 * POST /api/tyomaa/search — the existing (non-/api/cli/) route that also backs
 * the FE worksite typeahead. Body is `{ searchString: <query> }`; the backend
 * full-text-matches `searchString` against the worksite NAME, ALL FOUR ADDRESS
 * LINES (street / line 2 / postal code / city), driving instructions, memo,
 * formatted address, worksite number AND the contact person's name / phone /
 * email — so a street fragment finds the worksite. Results are scoped to the
 * caller's company (req.user.ownerAsiakasId) when no ownerAsiakasId is in the
 * body, so the CLI sends only searchString (+ optional limit).
 *
 * When `myCompanies` is true, adds `myCompanies: true` to the body so the
 * backend fans out across all companies the caller belongs to (rows tagged with
 * `ownerAsiakasId`).
 *
 * Sent as a `read` request: search is a tenant-scoped non-mutating POST, so
 * `read:true` exempts it from the `--read-only` write-lock and the acting-as
 * write diagnostic (it neither creates nor updates tenant data). Distinct from
 * `meta` (which is for non-tenant diagnostics such as `ib feedback`). The raw
 * Finnish-named recordset is projected into the universal `ListEnvelope` with
 * the same camelCase keys as `worksite get` for a consistent AI-facing shape.
 */
export async function runWorksiteSearch(client, query, limit, myCompanies = false) {
    const body = { searchString: query };
    if (limit !== undefined)
        body.limit = limit;
    if (myCompanies)
        body.myCompanies = true;
    const rows = await client.post("/api/tyomaa/search", body, { read: true });
    const items = (rows || []).map((r) => ({
        tyomaaId: r.tyomaaId,
        name: r.tyomaaNimi || null,
        tyomaaNum: r.tyomaaNum || null,
        address: r.tyomaaOsoite1 || null,
        address2: r.tyomaaOsoite2 || null,
        postalCode: r.tyomaaOsoite3 || null,
        city: r.tyomaaOsoite4 || null,
        formattedAddress: r.formattedAddress || null,
        coords: r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null,
        drivingInstructions: r.tyomaaAjoOhje || null,
        comment: r.tyomaaMemo || null,
    }));
    return listEnvelope(items);
}
/**
 * POST /api/tyomaa/new with a free-form body forwarded to the existing BE
 * endpoint (FE: `tyomaa_save_to_db()`). Write flags surface as the universal
 * `X-Dry-Run` / `Idempotency-Key` / `X-Action-Reason` headers.
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - `ownerAsiakasId` is required (validateRequiredFields).
 *   - `tyomaaContactPersonId` has a NOT NULL constraint; pass `0` for
 *     "no contact assigned".
 */
export async function runWorksiteCreate(client, body, flags) {
    return client.post("/api/tyomaa/new", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Today as YYYYMMDD (no separators) in Europe/Helsinki — the timezone every
 * date flag in this CLI is documented to use (a host-local build was off by one
 * on a UTC runner between 22:00–24:00 Helsinki). Used as the default `yyyymmdd`
 * URL segment for /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd when the
 * caller doesn't supply one.
 */
function todayYyyymmdd() {
    return todayHelsinki().replace(/-/g, "");
}
/**
 * Merge typed update flags over a parsed --body/--from-json patch (typed flags
 * win) into the /api/tyomaa/set patch body. Only fields whose flag was actually
 * provided are included, so any column the caller omitted is left out of the
 * patch — the backend `tyomaa.setData` read-merges omitted columns back to the
 * stored row (an explicit "" still clears). Body keys not covered by a typed
 * flag are preserved untouched. Flag vocabulary mirrors the `worksite get`
 * read projection (name/address/postalCode/city/comment/invoiceRef/…), and
 * matches `customer update` naming. Mirrors buildPersonUpdateBody (fb#234).
 */
export function buildWorksiteUpdateBody(parsedBody, typed) {
    const body = { ...parsedBody };
    if (typed.name !== undefined)
        body.tyomaaNimi = typed.name;
    if (typed.num !== undefined)
        body.tyomaaNum = typed.num;
    if (typed.address !== undefined)
        body.tyomaaOsoite1 = typed.address;
    if (typed.address2 !== undefined)
        body.tyomaaOsoite2 = typed.address2;
    if (typed.postalCode !== undefined)
        body.tyomaaOsoite3 = typed.postalCode;
    if (typed.city !== undefined)
        body.tyomaaOsoite4 = typed.city;
    if (typed.drivingInstructions !== undefined)
        body.tyomaaAjoOhje = typed.drivingInstructions;
    if (typed.comment !== undefined)
        body.tyomaaMemo = typed.comment;
    if (typed.invoiceRef !== undefined)
        body.laskuViite = typed.invoiceRef;
    if (typed.contactPerson !== undefined)
        body.tyomaaContactPersonId = typed.contactPerson;
    return body;
}
/**
 * POST /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd with the patch
 * body. `ownerAsiakasId` comes from the caller's credentials context and must
 * be passed in by the action wiring. `yyyymmdd` defaults to today in local
 * time (YYYYMMDD, no separators).
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - The handler runs `validateRequiredFields(body, ["tyomaaId", "ownerAsiakasId"])`,
 *     so both ids must be present in the BODY (not just the URL). We inject them
 *     from `opts` so callers only need to put the fields-to-update in the body.
 *   - Partial-body safety is SERVER-side: `tyomaa.setData` read-merges omitted
 *     columns from the stored row (fb#234; the `tyomaa_save` proc itself
 *     blanket-overwrites every column). DEPLOY-GATED — against a backend
 *     without that merge, a partial body NULLs the omitted columns.
 */
export async function runWorksiteUpdate(client, opts, body, flags) {
    const yyyymmdd = opts.yyyymmdd || todayYyyymmdd();
    // Inject the backend-required ids; the URL/derived ids are authoritative
    // (they override anything in --body), so the caller's body need only carry
    // the fields to change.
    const fullBody = {
        ...body,
        tyomaaId: opts.tyomaaId,
        ownerAsiakasId: opts.ownerAsiakasId,
    };
    return client.post(`/api/tyomaa/set/${opts.ownerAsiakasId}/${opts.tyomaaId}/${yyyymmdd}`, fullBody, { headers: writeFlagsToHeaders(flags) });
}
/**
 * GET /api/cli/worksite/metrics/:tyomaaId — volume / keikka-count summary plus
 * monthly breakdown. Owner derived from the JWT server-side.
 */
export async function runWorksiteMetrics(client, tyomaaId) {
    return client.get(`/api/cli/worksite/metrics/${tyomaaId}`);
}
/** GET /api/cli/worksite/dates/:tyomaaId — a worksite's compliance dates. */
export async function runWorksiteDatesList(client, tyomaaId) {
    return client.get(`/api/cli/worksite/dates/${tyomaaId}`);
}
/** GET /api/cli/worksite/dates/expiring?days=N — company-wide expiry feed. */
export async function runWorksiteDatesExpiring(client, days) {
    const d = days !== undefined ? days : 30;
    return client.get(`/api/cli/worksite/dates/expiring?days=${d}`);
}
/** POST /api/tyomaa/refreshLocation/:tyomaaId — re-geocode from Google Maps. */
export async function runWorksiteRefreshLocation(client, tyomaaId, flags) {
    return client.post(`/api/tyomaa/refreshLocation/${tyomaaId}`, {}, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** POST /api/tyomaa/:tyomaaId/geofence-radius — set geofence radius (1-10000 m). */
export async function runWorksiteSetGeofence(client, tyomaaId, radius, flags) {
    return client.post(`/api/tyomaa/${tyomaaId}/geofence-radius`, { geofenceRadius: radius }, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** POST /api/tyomaa/helsinki/fetch/:tyomaaId — refresh Helsinki building data. */
export async function runWorksiteHelsinkiFetch(client, tyomaaId, flags) {
    return client.post(`/api/tyomaa/helsinki/fetch/${tyomaaId}`, {}, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * DELETE /api/tyomaa/delete/:tyomaaId. Universal write flags surface as
 * headers; `--reason` is enforced by the CLI layer.
 */
export async function runWorksiteDelete(client, tyomaaId, flags) {
    return client.delete(`/api/tyomaa/delete/${tyomaaId}`, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/tyomaa/person/add — attach a person to a worksite.
 * Body is `{ tyomaaId, personId, contactPersonTypeId }` (the last defaults to 1
 * on the CLI surface, matching the FE default for tyomaaPerson links).
 * Forwards the universal write-flag headers.
 */
export async function runWorksitePersonAdd(client, body, flags) {
    return client.post("/api/tyomaa/person/add", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/tyomaa/person/remove — detach a person from a worksite.
 * Forwards the universal write-flag headers.
 */
export async function runWorksitePersonRemove(client, body, flags) {
    return client.post("/api/tyomaa/person/remove", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * GET /api/tyomaa/person/list/:tyomaaId/0 — returns persons attached to a
 * worksite. The second URL segment is a typeId placeholder (the FE / BE
 * route shape mirrors `asiakas/person/list`); we always pass `0` because
 * tyomaaPerson links don't have a per-role filter. The flat backend array is
 * wrapped in the universal `ListEnvelope` so output formatters can render it.
 */
export async function runWorksitePersonList(client, tyomaaId) {
    const rows = await client.get(`/api/tyomaa/person/list/${tyomaaId}/0`);
    const items = (rows || []).map((r) => ({
        personId: r.personId,
        name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
        email: r.personEmail || null,
        contactType: r.contactPersonTypeId || null,
    }));
    return listEnvelope(items);
}
/**
 * `ib worksite dashboard` — resolve the caller's point from exactly one of
 * `tyomaaId` / `address` and delegate to the shared
 * {@link runAddressDashboard} orchestrator (Address Information Dashboard,
 * spec 2026-07-01): weather, building, cadastral parcel, nearby traffic
 * cameras, nearby sijainnit, worksite deliveries, and nearby vehicles merged
 * into one report. The exactly-one validation is the caller's job (the
 * command action, mirroring `ib opendata building`'s `selectedSources`
 * pattern) — this function just forwards whichever one is set.
 */
export async function runWorksiteDashboard(client, opts) {
    return runAddressDashboard(client, opts.address !== undefined ? { address: opts.address } : { tyomaaId: opts.tyomaaId });
}
/**
 * Register `ib worksite` subcommands on the parent commander instance:
 *   - list            filterable by --limit/--cursor
 *   - get             single tyomaa by id
 *   - metrics         GET /api/cli/worksite/metrics/:id (volume/keikka counts)
 *   - dates list      GET /api/cli/worksite/dates/:id (compliance dates, read-only)
 *   - dates expiring  GET /api/cli/worksite/dates/expiring?days=N (read-only)
 *   - search          free-text search (existing POST /api/tyomaa/search route)
 *   - dashboard       one-shot Address Information Dashboard report (read-only)
 *   - create          POST /api/tyomaa/new with --body JSON (write flags)
 *   - update          POST /api/tyomaa/set/<ownerAsiakasId>/<tyomaaId>/<yyyymmdd>
 *   - delete          DELETE /api/tyomaa/delete/:id (write flags, --reason)
 *   - refresh-location POST /api/tyomaa/refreshLocation/:id (write flags)
 *   - set-geofence    POST /api/tyomaa/:id/geofence-radius (write flags)
 *   - helsinki-fetch  POST /api/tyomaa/helsinki/fetch/:id (write flags)
 *   - person add/remove/list  tyomaaPerson link management
 *   - duplicates      likely-duplicate worksite pairs for a tenant (read; admin; feeds merge)
 *   - merge           merge two duplicate worksites (--dry-run = /validate; IRREVERSIBLE; requires --reason)
 *
 * The `update` action derives ownerAsiakasId from the session JWT via
 * `ownerAsiakasIdFromToken` — no --owner-asiakas-id flag required.
 * `--yyyymmdd` defaults to today.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
/** tyomaa-combinator request-body id fields (see puminet5api tyomaaCombinatorRoutes). */
const TYOMAA_MERGE_ID_FIELDS = {
    mainField: "mainTyomaaId",
    secondaryField: "secondaryTyomaaId",
};
/**
 * GET /api/admin/tyomaa-combinator/duplicates — likely-duplicate worksite pairs
 * for one tenant (strict name+address+num, or the anonymous same-address cluster).
 * Admin gated server-side. Feeds `ib worksite merge`. See runCombinatorDuplicates.
 */
export function runWorksiteDuplicates(client, ownerAsiakasId) {
    return runCombinatorDuplicates(client, "tyomaa-combinator", ownerAsiakasId);
}
/**
 * Merge two duplicate worksites — the secondary's references move onto the main,
 * then the secondary is deleted. IRREVERSIBLE, admin gated. `--dry-run` runs the
 * read-only /validate safety check (works under --read-only). See runCombinatorMerge.
 */
export function runWorksiteMerge(client, opts, flags) {
    return runCombinatorMerge(client, "tyomaa-combinator", TYOMAA_MERGE_ID_FIELDS, opts, flags);
}
export function registerWorksiteCommands(parent, getClient) {
    const w = parent.command("worksite").description("Worksite commands");
    w.command("list")
        .option("--limit <n>", "", cappedInt(500))
        .option("--cursor <c>")
        .option("--customer <n>", "", (v) => Number(v))
        .action(jsonAction(getClient, (client, opts) => runWorksiteList(client, { limit: opts.limit, cursor: opts.cursor, customer: opts.customer })));
    w.command("get <tyomaaId>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .option("--include-building")
        .option("--include-cameras")
        .action(jsonAction(getClient, (client, idStr, opts) => runWorksiteGet(client, parseId(idStr, "tyomaaId"), {
        includeBuilding: opts.includeBuilding,
        includeCameras: opts.includeCameras,
    })));
    w.command("metrics <tyomaaId>")
        .action(jsonAction(getClient, (client, idStr) => runWorksiteMetrics(client, parseId(idStr, "tyomaaId"))));
    const dates = w.command("dates").description("Worksite compliance dates (read-only)");
    dates
        .command("list <tyomaaId>")
        .action(jsonAction(getClient, (client, idStr) => runWorksiteDatesList(client, parseId(idStr, "tyomaaId"))));
    dates
        .command("expiring")
        .option("--days <n>", "", (v) => Number(v))
        .action(jsonAction(getClient, (client, opts) => runWorksiteDatesExpiring(client, opts.days)));
    w.command("search [query]")
        .option("--search <s>")
        .addOption(queryAliasOption())
        .option("--limit <n>", "", cappedInt(500))
        .option("--my-companies")
        .action(jsonAction(getClient, (client, query, opts) => runWorksiteSearch(client, resolveSearchQuery(query, opts.search, opts.query), opts.limit, !!opts.myCompanies)));
    registerDashboardCommand(w, getClient, {
        idArg: "tyomaaId",
        addressDescription: "Resolve the point from a street address instead of tyomaaId",
        run: (client, tyomaaId, address) => runWorksiteDashboard(client, { tyomaaId, address }),
    });
    const createCmd = w
        .command("create")
        .requiredOption("--body <json>");
    addWriteFlagsToCommand(createCmd).action(guarded(async (opts) => {
        const client = await getClient();
        const parsed = parseJsonBodyFlag(opts.body);
        const result = await runWorksiteCreate(client, parsed, opts);
        writeJson(result);
    }));
    const updateCmd = w
        .command("update <tyomaaId>")
        .option("--name <s>")
        .option("--num <s>")
        .option("--address <s>")
        .option("--address2 <s>")
        .option("--postal-code <s>")
        .option("--city <s>")
        .option("--driving-instructions <s>")
        .option("--comment <s>")
        .option("--invoice-ref <s>")
        .option("--contact-person <id>", "", (v) => Number(v))
        .option("--body <json>")
        .option("--from-json <file>")
        .option("--yyyymmdd <date>");
    addWriteFlagsToCommand(updateCmd).action(guarded(async (idStr, opts) => {
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        // `opts` IS a WorksiteUpdateFlags (plus the write/body flags); the builder
        // reads only the ten named fields, so it takes the options object directly.
        const patch = buildWorksiteUpdateBody(parsed, opts);
        if (Object.keys(patch).length === 0) {
            failWith("update requires at least one field: typed flags (--name/--num/--address/--address2/--postal-code/--city/--driving-instructions/--comment/--invoice-ref/--contact-person) or a --body/--from-json JSON patch", 4);
        }
        const client = await getClient();
        const ownerAsiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
        const result = await runWorksiteUpdate(client, { tyomaaId: parseId(idStr, "tyomaaId"), ownerAsiakasId, yyyymmdd: opts.yyyymmdd }, patch, opts);
        writeJson(result);
    }));
    addWriteFlagsToCommand(w
        .command("delete <tyomaaId>")).action(guarded(async (tyomaaIdStr, opts) => {
        const client = await getClient();
        const result = await runWorksiteDelete(client, parseId(tyomaaIdStr, "tyomaaId"), opts);
        writeJson(result);
    }));
    addWriteFlagsToCommand(w.command("refresh-location <tyomaaId>")).action(jsonAction(getClient, (client, idStr, opts) => runWorksiteRefreshLocation(client, parseId(idStr, "tyomaaId"), opts)));
    addWriteFlagsToCommand(w.command("set-geofence <tyomaaId>")
        .requiredOption("--radius <m>", "", Number)).action(guarded(async (idStr, opts) => {
        if (!Number.isInteger(opts.radius) || opts.radius < 1 || opts.radius > 10000) {
            failWith("--radius must be an integer between 1 and 10000", 4);
        }
        const client = await getClient();
        writeJson(await runWorksiteSetGeofence(client, parseId(idStr, "tyomaaId"), opts.radius, opts));
    }));
    addWriteFlagsToCommand(w.command("helsinki-fetch <tyomaaId>")).action(jsonAction(getClient, (client, idStr, opts) => runWorksiteHelsinkiFetch(client, parseId(idStr, "tyomaaId"), opts)));
    const worksitePerson = w
        .command("person")
        .description("Manage persons attached to a worksite");
    registerPersonLinkCommands(worksitePerson, getClient, {
        targetFlag: "worksite",
        targetDescription: "Target tyomaaId",
        targetField: "tyomaaId",
        contactTypeDescription: "contactPersonTypeId (default 1)",
        add: runWorksitePersonAdd,
        remove: runWorksitePersonRemove,
    });
    worksitePerson
        .command("list [tyomaaId]")
        .option("--worksite <id>", "", Number)
        .action(jsonAction(getClient, (client, tyomaaIdStr, opts) => runWorksitePersonList(client, resolveTarget(tyomaaIdStr, opts.worksite, "tyomaaId", "worksite"))));
    registerLogAlias(w, getClient, "tyomaa", "tyomaaId");
    registerCombinatorCommands(w, getClient, {
        base: "tyomaa-combinator",
        idFields: TYOMAA_MERGE_ID_FIELDS,
        idLabel: "tyomaaId",
    });
}
//# sourceMappingURL=index.js.map