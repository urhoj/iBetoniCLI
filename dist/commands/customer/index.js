import { createRequire } from "node:module";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { resolveRoleTypeId } from "../../roles.js";
/**
 * GET /api/cli/customer/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`. `--full` returns the
 * full flat-customer fields + companyDescription; `--ids` restricts to specific
 * asiakasIds — together they make incremental "diff only what changed" runs a
 * single call instead of N×`customer get`.
 */
export async function runCustomerList(client, opts) {
    const params = new URLSearchParams();
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.cursor)
        params.set("cursor", opts.cursor);
    if (opts.full)
        params.set("full", "1");
    if (opts.ids && opts.ids.length > 0)
        params.set("ids", opts.ids.join(","));
    if (opts.include && opts.include.length > 0)
        params.set("include", opts.include.join(","));
    const qs = params.toString();
    return client.get(`/api/cli/customer/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/customer/get/:asiakasId. Returns the flat backend record as-is.
 */
export async function runCustomerGet(client, asiakasId) {
    return client.get(`/api/cli/customer/get/${asiakasId}`);
}
/**
 * GET /api/cli/customer/by-ytunnus/:ytunnus — exact-match lookup by business ID,
 * the key for `customer create-or-update`. Tenant-scoped (system admins:
 * cross-tenant). Returns ALL matches as flat records — caller treats 0 = create,
 * 1 = update, >1 = ambiguous.
 */
export async function runCustomerByYtunnus(client, ytunnus) {
    const res = await client.get(`/api/cli/customer/by-ytunnus/${encodeURIComponent(ytunnus)}`);
    return Array.isArray(res?.items) ? res.items : [];
}
/**
 * Upsert a customer keyed by business ID (ytunnus). Looks it up (tenant-scoped;
 * system admins cross-tenant); 1 match → update via read-merge from the matched
 * flat record, 0 → create (PRH prefill when --from-prh), >1 → throws (ambiguous).
 * Returns the resulting flat customer plus `action: created|updated`. On
 * --dry-run returns the backend echo with `action: would-create|would-update`.
 * Throws on a missing key / ambiguous match (caller maps to exit 4).
 */
export async function runCustomerUpsert(client, opts, flags) {
    const prhYt = opts.fromPrh;
    let key = (prhYt || opts.ytunnus || "").trim();
    if (!key && opts.body) {
        try {
            const b = JSON.parse(opts.body);
            key = String(b.yTunnus ?? b.ytunnus ?? "").trim();
        }
        catch {
            /* malformed --body is surfaced by the builders below */
        }
    }
    if (!key) {
        throw new Error("create-or-update requires --ytunnus (or --from-prh / --body with yTunnus)");
    }
    const matches = await runCustomerByYtunnus(client, key);
    if (matches.length > 1) {
        throw new Error(`ambiguous: ${matches.length} customers share ytunnus ${key} (ids: ${matches
            .map((m) => m.asiakasId)
            .join(", ")}). Use \`ib customer update <id>\`.`);
    }
    if (matches.length === 1) {
        const current = matches[0];
        const updateBody = buildAsiakasUpdateBody(current, {
            name: opts.name,
            ytunnus: opts.ytunnus,
            email: opts.email,
            shortName: opts.shortName,
            comment: opts.comment,
            contactPerson: opts.contactPerson,
            type: opts.type,
            address: opts.address,
            postalCode: opts.postalCode,
            city: opts.city,
            body: opts.body,
        });
        const res = await runCustomerUpdate(client, current.asiakasId, updateBody, flags);
        if (flags.dryRun)
            return { action: "would-update", asiakasId: current.asiakasId, dryRun: res };
        const changed = res?.changed ?? null;
        return { ...(await runCustomerGet(client, current.asiakasId)), action: "updated", changed };
    }
    // No match → create. PRH is fetched only here (not on update).
    const ownerAsiakasId = await resolveCurrentOwnerAsiakasId(client);
    const prh = prhYt ? await runCustomerPrhById(client, prhYt) : undefined;
    const createBody = buildAsiakasCreateBody({
        name: opts.name,
        ytunnus: opts.ytunnus,
        email: opts.email,
        shortName: opts.shortName,
        fromPrh: prhYt,
        address: opts.address,
        postalCode: opts.postalCode,
        city: opts.city,
        body: opts.body,
    }, ownerAsiakasId, prh);
    if (createBody.yTunnus === undefined || createBody.yTunnus === null || createBody.yTunnus === "") {
        createBody.yTunnus = key;
    }
    const res = await runCustomerCreate(client, createBody, flags);
    if (flags.dryRun)
        return { action: "would-create", dryRun: res };
    const newId = extractAsiakasId(res);
    if (!newId)
        return { ...res, action: "created" };
    return { ...(await runCustomerGet(client, newId)), action: "created" };
}
/**
 * GET /api/cli/customer/modules/:asiakasId — report roolit booleans + the 8
 * module flags the CLI exposes. Read-only; admin-gated server-side (system
 * admin may read any tenant). Returns the backend shape verbatim.
 */
export async function runCustomerModulesReport(client, asiakasId) {
    return client.get(`/api/cli/customer/modules/${asiakasId}`);
}
/** asiakasSettings-backed module field keys (excludes the roolit-backed `pumppu`). */
export const MODULE_FIELD_KEYS = [
    "jerry",
    "henkilot",
    "sijainnit",
    "ajoneuvot",
    "tiedostot",
    "weather",
    "lomaseuranta",
    "shareorders",
];
/** Every togglable field key: the 8 modules plus `pumppu` (isPumppuToimittaja). */
export const ALL_FIELD_KEYS = ["pumppu", ...MODULE_FIELD_KEYS];
/** Friendly alias → canonical ASIAKAS_SETTING_TYPE_IDS key (the 8 the modules cmd exposes). */
const SETTING_ALIASES = {
    jerry: "HAS_JERRY",
    henkilot: "HAS_HENKILOT",
    sijainnit: "HAS_SIJAINNIT",
    ajoneuvot: "HAS_AJONEUVOT",
    tiedostot: "HAS_TIEDOSTOT",
    weather: "HAS_WEATHER",
    lomaseuranta: "LOMASEURANTA",
    shareorders: "SHARE_ORDERS_WITH_BETONI",
};
/**
 * Build a lowercase-key → asiakasSettingTypeId map covering every canonical
 * ASIAKAS_SETTING_TYPE_IDS name PLUS the 8 friendly aliases, sourced once
 * (memoized) from @ibetoni/constants. `pumppu` is intentionally absent — it is
 * a roolit column, handled separately. Replaces the old 8-key moduleKeyToTypeId().
 * Memoized so validation (allSettingKeys) and the typeId lookup
 * (applySettingWrites) provably share one source and skip the rebuild.
 */
let _settingTypeIdMap = null;
function settingTypeIdMap() {
    if (_settingTypeIdMap)
        return _settingTypeIdMap;
    const constants = cjsRequire("@ibetoni/constants");
    const ids = constants.ASIAKAS_SETTING_TYPE_IDS;
    const map = {};
    for (const [name, id] of Object.entries(ids))
        map[name.toLowerCase()] = id;
    for (const [alias, canonical] of Object.entries(SETTING_ALIASES))
        map[alias] = ids[canonical];
    _settingTypeIdMap = map;
    return map;
}
/** Every valid settings key for --set/--unset: all canonical (lowercased) + aliases + pumppu. */
function allSettingKeys() {
    return new Set([...Object.keys(settingTypeIdMap()), "pumppu"]);
}
/**
 * Parse --set / --unset comma-separated field lists into a desired-state map
 * (key -> boolean). Validates each key against ALL_FIELD_KEYS and rejects a
 * key requested both ON and OFF. Throws (caller exits 4) on bad input.
 */
export function parseModuleChanges(setCsv, unsetCsv) {
    const changes = new Map();
    const valid = new Set(ALL_FIELD_KEYS);
    const apply = (csv, value) => {
        if (!csv)
            return;
        for (const raw of csv.split(",")) {
            const key = raw.trim().toLowerCase();
            if (!key)
                continue;
            if (!valid.has(key)) {
                throw new Error(`unknown field: ${key}. Valid: ${ALL_FIELD_KEYS.join(", ")}`);
            }
            if (changes.has(key) && changes.get(key) !== value) {
                throw new Error(`field '${key}' given to both --set and --unset`);
            }
            changes.set(key, value);
        }
    };
    apply(setCsv, true);
    apply(unsetCsv, false);
    if (changes.size === 0) {
        throw new Error("no fields given — pass --set and/or --unset");
    }
    return changes;
}
/**
 * Parse --set/--unset CSV lists into a desired-state map over the FULL setting
 * surface (canonical names case-insensitive, the 8 aliases, and pumppu). Same
 * validation contract as parseModuleChanges but a wider valid set.
 */
export function parseSettingChanges(setCsv, unsetCsv) {
    const changes = new Map();
    const valid = allSettingKeys();
    const apply = (csv, value) => {
        if (!csv)
            return;
        for (const raw of csv.split(",")) {
            const key = raw.trim().toLowerCase();
            if (!key)
                continue;
            if (!valid.has(key)) {
                throw new Error(`unknown field: ${key}. Valid: ${[...valid].sort().join(", ")}`);
            }
            if (changes.has(key) && changes.get(key) !== value) {
                throw new Error(`field '${key}' given to both --set and --unset`);
            }
            changes.set(key, value);
        }
    };
    apply(setCsv, true);
    apply(unsetCsv, false);
    if (changes.size === 0)
        throw new Error("no fields given — pass --set and/or --unset");
    return changes;
}
/** GET /api/cli/customer/settings/:asiakasId — admin-gated; returns the raw report. */
export async function runCustomerSettingsReport(client, asiakasId) {
    return client.get(`/api/cli/customer/settings/${asiakasId}`);
}
/**
 * Shared write core for both module and settings applies: pumppu → setRoolit
 * (echoing the other three roolit booleans from the modules report), the rest
 * → one settings/save batch (self laskuttaja, upsert). Resolves typeIds via the
 * full settingTypeIdMap so it accepts canonical names AND the 8 aliases.
 */
async function applySettingWrites(client, asiakasId, changes, flags) {
    const headers = writeFlagsToHeaders(flags);
    if (changes.has("pumppu")) {
        const current = await runCustomerModulesReport(client, asiakasId);
        const r = current.roolit;
        await client.post("/api/asiakas/setRoolit", {
            asiakasId,
            isTyomaaAsiakas: r.isTyomaaAsiakas,
            isPumppuToimittaja: changes.get("pumppu"),
            isBetoniToimittaja: r.isBetoniToimittaja,
            isLattiaToimittaja: r.isLattiaToimittaja,
        }, { headers });
    }
    const typeIds = settingTypeIdMap();
    const settings = [...changes.entries()]
        .filter(([key]) => key !== "pumppu")
        .map(([key, value]) => ({
        asiakasSettingId: null,
        asiakasId,
        laskuttajaAsiakasId: asiakasId,
        asiakasSettingTypeId: typeIds[key],
        asiakasSettingBool: value,
    }));
    if (settings.length > 0) {
        await client.post("/api/asiakas/settings/save", settings, { headers });
    }
}
/**
 * Summarise a change-map as the `{ set, unset, dryRun }` shape shared by the
 * modules and settings apply results.
 */
function appliedFromChanges(changes, flags) {
    return {
        set: [...changes].filter(([, v]) => v).map(([k]) => k),
        unset: [...changes].filter(([, v]) => !v).map(([k]) => k),
        dryRun: !!flags.dryRun,
    };
}
/**
 * Apply setting/roolit changes, then re-fetch and return the FULL settings state
 * (roolit + every canonical ASIAKAS_SETTING_TYPE_IDS). Writes are delegated to
 * applySettingWrites; the returned `state` is the post-write settings report —
 * with --dry-run the write is skipped server-side, so the report reflects the
 * unchanged current state.
 */
export async function runCustomerSettingsApply(client, asiakasId, changes, flags) {
    await applySettingWrites(client, asiakasId, changes, flags);
    const state = await runCustomerSettingsReport(client, asiakasId);
    return { asiakasId, applied: appliedFromChanges(changes, flags), state };
}
/**
 * Apply a desired-state map to one customer. `pumppu` routes to
 * POST /api/asiakas/setRoolit (echoing the other three roolit booleans
 * unchanged); module keys batch into POST /api/asiakas/settings/save with
 * laskuttajaAsiakasId = asiakasId (self-billing) and asiakasSettingId null
 * (upsert). Re-fetches and returns the resulting state. Both writes are
 * admin-gated server-side; --dry-run / --reason / --idempotency-key flow
 * through as the universal headers.
 */
export async function runCustomerModulesApply(client, asiakasId, changes, flags) {
    await applySettingWrites(client, asiakasId, changes, flags);
    const state = await runCustomerModulesReport(client, asiakasId);
    return { asiakasId, applied: appliedFromChanges(changes, flags), state };
}
/**
 * Build the operator-preset desired-state map: every one of the 9 fields set
 * to `value`. Used by `ib customer operator --set` (true) / `--reset` (false).
 */
export function operatorPresetChanges(value) {
    return new Map(ALL_FIELD_KEYS.map((k) => [k, value]));
}
/**
 * Verify the operator preset for one customer: reads the modules report and
 * checks all 9 operator fields are ON (pumppu via roolit.isPumppuToimittaja,
 * the 8 modules via their flags). Pure read — the caller maps `allSet` to the
 * process exit code (0 when fully provisioned, 1 otherwise).
 */
export async function runCustomerOperatorVerify(client, asiakasId) {
    const state = await runCustomerModulesReport(client, asiakasId);
    const flags = {
        pumppu: state.roolit.isPumppuToimittaja,
    };
    for (const key of MODULE_FIELD_KEYS)
        flags[key] = !!state.modules[key];
    const missing = ALL_FIELD_KEYS.filter((k) => !flags[k]);
    return { asiakasId, allSet: missing.length === 0, flags, missing };
}
/**
 * GET /api/tyomaa/asiakasTyomaaList/:asiakasId — worksites belonging to a
 * customer. Backend returns a raw array; wrapped into the universal envelope.
 */
export async function runCustomerWorksites(client, asiakasId) {
    const rows = await client.get(`/api/tyomaa/asiakasTyomaaList/${asiakasId}`);
    const items = (rows || []).map((r) => ({
        tyomaaId: r.tyomaaId,
        name: r.tyomaaNimi || null,
        address: r.tyomaaOsoite1 || null,
        city: r.tyomaaOsoite4 || null,
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * GET /api/asiakas/search?searchString=<query> — existing (non-/api/cli/) route
 * used by the FE customer typeahead. The backend scopes results to the caller's
 * company (req.user.ownerAsiakasId) when no ownerAsiakasId query param is given,
 * so the CLI sends only searchString. Result shape is whatever the backend
 * returns (typically an array of asiakas records).
 */
export async function runCustomerSearch(client, query, limit) {
    const params = new URLSearchParams({ searchString: query });
    if (limit !== undefined)
        params.set("limit", String(limit));
    return client.get(`/api/asiakas/search?${params.toString()}`);
}
/**
 * POST /api/asiakas/createY with a free-form body forwarded to the existing
 * BE endpoint (FE: `asiakas_createY()`). Write flags are surfaced as
 * `X-Dry-Run`, `Idempotency-Key`, and `X-Action-Reason` headers.
 */
export async function runCustomerCreate(client, body, flags) {
    return client.post("/api/asiakas/createY", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * POST /api/asiakas/set/:asiakasId with a free-form body forwarded to the
 * existing BE endpoint. Write flags surface as the universal headers.
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - Include `saveGlobalAsiakas: true` — without it the handler returns
 *     `success: true` but actually no-ops on the global asiakas row.
 *   - `asiakasContactPersonId` (NOT NULL) must be present; `0` is a valid
 *     "no contact person assigned" sentinel.
 */
export async function runCustomerUpdate(client, asiakasId, body, flags) {
    return client.post(`/api/asiakas/set/${asiakasId}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * DELETE /api/asiakas/delete/:asiakasId/:ownerAsiakasId. Universal write flags
 * surface as headers; `--reason` is enforced by the CLI layer.
 */
export async function runCustomerDelete(client, asiakasId, ownerAsiakasId, flags) {
    return client.delete(`/api/asiakas/delete/${asiakasId}/${ownerAsiakasId}`, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/asiakas/person/add — attach a person to a customer.
 * Forwards the universal write-flag headers.
 */
export async function runCustomerPersonAdd(client, body, flags) {
    return client.post("/api/asiakas/person/add", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * GET /api/prh/company/:businessId — single company from the Finnish business
 * registry. Backend wraps as { success, data, timestamp }; unwrap `.data`.
 * 404 (unknown Y-tunnus) → CliError exit 5; invalid format → exit 4.
 */
export async function runCustomerPrhById(client, ytunnus) {
    const res = await client.get(`/api/prh/company/${encodeURIComponent(ytunnus)}`);
    return res.data;
}
/**
 * GET /api/prh/search/name?q=&page= — name search. Backend wraps as
 * { success, data: { companies, totalResults, … }, timestamp }. Project the
 * companies into the universal list envelope.
 */
export async function runCustomerPrhSearch(client, name, page = 1) {
    const qs = new URLSearchParams({ q: name, page: String(page) }).toString();
    const res = await client.get(`/api/prh/search/name?${qs}`);
    const companies = res.data?.companies ?? [];
    return {
        items: companies.map((c) => ({
            businessId: c.businessId,
            name: c.name,
            city: c.address?.city ?? null,
        })),
        nextCursor: null,
        count: companies.length,
    };
}
/**
 * GET /api/changes/asiakas/:asiakasId/:ownerAsiakasId — the change-tracker
 * audit trail for one customer (the same log the CLI's --reason writes feed).
 * Returns a RAW array (sendSuccess(changes), no .data wrapper). Owner resolved
 * from the active company. Auth: company member or admin (BE-enforced).
 */
export async function runCustomerHistory(client, asiakasId, limit) {
    const owner = await resolveCurrentOwnerAsiakasId(client);
    const rows = await client.get(`/api/changes/asiakas/${asiakasId}/${owner}?limit=${limit}`);
    const list = Array.isArray(rows) ? rows : [];
    return {
        items: list.map((r) => ({
            changeId: r.changeId,
            field: r.fieldName ?? null,
            oldValue: r.oldValue ?? null,
            newValue: r.newValue ?? null,
            changeType: r.changeType ?? null,
            personId: r.personId ?? null,
            personName: r.personFullName ?? null,
            at: r.timestamp ?? null,
            description: r.description ?? null,
            reason: r.reason ?? null,
        })),
        nextCursor: null,
        count: list.length,
    };
}
/**
 * POST /api/asiakas/person/remove — detach a person from a customer.
 * Forwards the universal write-flag headers.
 */
export async function runCustomerPersonRemove(client, body, flags) {
    return client.post("/api/asiakas/person/remove", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Assemble the POST /api/asiakas/createY body from typed flags (+ optional PRH
 * prefill). createY accepts yTunnus(camelCase,REQUIRED) / email / asiakasNimi /
 * asiakasShortNimi / ownerAsiakasId(REQUIRED) + the billing address
 * (laskutusOsoite / laskutusPostinumero / laskutusKaupunki); it ignores
 * asiakasTypeId. Precedence (low→high): PRH prefill < explicit flags < raw --body.
 */
export function buildAsiakasCreateBody(flags, ownerAsiakasId, prh) {
    const body = { ownerAsiakasId };
    if (prh) {
        // "Unknown" is prhService's sentinel for a company with no registered
        // primary name — don't persist it as the customer name (explicit --name wins).
        if (prh.name && prh.name !== "Unknown")
            body.asiakasNimi = prh.name;
        if (prh.businessId)
            body.yTunnus = prh.businessId;
        // PRH carries the registered address — persist it as the billing address.
        if (prh.address?.street)
            body.laskutusOsoite = prh.address.street;
        if (prh.address?.postCode)
            body.laskutusPostinumero = prh.address.postCode;
        if (prh.address?.city)
            body.laskutusKaupunki = prh.address.city;
    }
    if (flags.name !== undefined)
        body.asiakasNimi = flags.name;
    if (flags.ytunnus !== undefined)
        body.yTunnus = flags.ytunnus;
    // createY's invoicing-email column is `email` (asiakasSql.createY → input("email", ...));
    // setData/update uses `laskutusEmail` instead — the two endpoints differ by design.
    if (flags.email !== undefined)
        body.email = flags.email;
    if (flags.shortName !== undefined)
        body.asiakasShortNimi = flags.shortName;
    applyBillingFlags(body, flags);
    if (flags.body)
        Object.assign(body, parseJsonBodyFlag(flags.body));
    return body;
}
/**
 * Overlay the billing-address flags (--address/--postal-code/--city → the
 * laskutus* columns) onto a body. Shared by the create and update builders so
 * the mapping lives in one place. Only sets a field when the flag was provided.
 */
function applyBillingFlags(body, flags) {
    if (flags.address !== undefined)
        body.laskutusOsoite = flags.address;
    if (flags.postalCode !== undefined)
        body.laskutusPostinumero = flags.postalCode;
    if (flags.city !== undefined)
        body.laskutusKaupunki = flags.city;
}
/** Pull the new asiakasId out of createY's response (tolerant of legacy shapes). */
export function extractAsiakasId(res) {
    const r = res;
    if (!r || typeof r !== "object")
        return null;
    const candidates = [
        r.returnValue,
        r.asiakasId,
        r.recordset?.[0]?.asiakasId,
        r.data?.returnValue,
    ];
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isInteger(n) && n > 0)
            return n;
    }
    return null;
}
/**
 * Read-merge-write: seed the full setData body from the CURRENT flat record so
 * unspecified fields (notably asiakasContactPersonId, which setData overwrites
 * unconditionally) are preserved, then overlay provided flags, then raw --body.
 * Always sets saveGlobalAsiakas:true (else setData no-ops on the global row).
 */
export function buildAsiakasUpdateBody(current, flags, prh) {
    // Seed every field setData writes from the current record (read-merge-write).
    // Billing address (laskutusOsoite/laskutusPostinumero/laskutusKaupunki) is now
    // writable; seeding the current value means the COALESCE in asiakas_save just
    // re-writes it unchanged unless a flag overrides. phone is still read-only
    // (no asiakas phone column). asiakasTypeId ?? 1 mirrors setData's own
    // `req.body.asiakasTypeId || 1` default; a real non-null type (incl. 0) is preserved.
    const body = {
        ytunnus: current.yTunnus ?? null,
        asiakasNimi: current.name ?? null,
        asiakasTypeId: current.type ?? 1,
        laskutusEmail: current.email ?? null,
        asiakasContactPersonId: current.contactPersonId ?? 0,
        asiakasShortNimi: current.shortName ?? null,
        kommentti: current.comment ?? null,
        laskutusOsoite: current.address ?? null,
        laskutusPostinumero: current.postalCode ?? null,
        laskutusKaupunki: current.city ?? null,
        saveGlobalAsiakas: true,
    };
    // --from-prh refresh: overlay the registry values between the current-record
    // seed and the explicit flags, so name/yTunnus/address are refreshed from PRH
    // but an explicit --flag still wins. (setData's ytunnus key is lowercase.)
    if (prh) {
        if (prh.name && prh.name !== "Unknown")
            body.asiakasNimi = prh.name;
        if (prh.businessId)
            body.ytunnus = prh.businessId;
        if (prh.address?.street)
            body.laskutusOsoite = prh.address.street;
        if (prh.address?.postCode)
            body.laskutusPostinumero = prh.address.postCode;
        if (prh.address?.city)
            body.laskutusKaupunki = prh.address.city;
    }
    if (flags.name !== undefined)
        body.asiakasNimi = flags.name;
    if (flags.ytunnus !== undefined)
        body.ytunnus = flags.ytunnus;
    if (flags.email !== undefined)
        body.laskutusEmail = flags.email;
    if (flags.shortName !== undefined)
        body.asiakasShortNimi = flags.shortName;
    if (flags.comment !== undefined)
        body.kommentti = flags.comment;
    if (flags.contactPerson !== undefined)
        body.asiakasContactPersonId = flags.contactPerson;
    if (flags.type !== undefined)
        body.asiakasTypeId = flags.type;
    applyBillingFlags(body, flags);
    if (flags.body)
        Object.assign(body, parseJsonBodyFlag(flags.body));
    return body;
}
/**
 * Register `ib customer` subcommands on the parent commander instance:
 *   - list      filterable by --limit/--cursor
 *   - get       single asiakas by id (flat shape incl. contactPersonId/shortName/comment)
 *   - worksites the customer's worksites (GET /api/tyomaa/asiakasTyomaaList/:asiakasId)
 *   - search    free-text search (existing /api/asiakas/search route)
 *   - prh       Finnish business-registry lookup (by Y-tunnus or --search name)
 *   - create    typed flags assemble the createY body; --from-prh prefills; --body overrides (write flags)
 *   - update    read-merge-write via typed flags; --body overrides (write flags)
 *   - create-or-update  upsert keyed by ytunnus (lookup → update or create; alias `upsert`)
 *   - delete    DELETE /api/asiakas/delete/<id>/<owner> (requires --reason)
 *   - history   change-tracker audit trail for one customer
 *   - modules   report/toggle roolit + the 8 module flags (admin-gated; write flags)
 *   - operator  verify/provision all 9 operator flags at once (admin-gated; write flags)
 *   - settings  report/toggle ALL asiakasSettings + pumppu (admin-gated; write flags)
 *   - person add / remove / list   manage persons attached to a customer
 *
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 2 = auth · 3 = permission · 4 = validation · 5 = not-found.
 */
export function registerCustomerCommands(parent, getClient) {
    const c = parent.command("customer").description("Customer commands");
    c.command("list")
        .description("List customers. --full returns every flat-customer field + jerry " +
        "companyDescription in one call (for diffing a whole tenant); --ids " +
        "1,2,3 restricts to specific asiakasIds (refresh only what changed).")
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .option("--cursor <c>", "Pagination cursor")
        .option("--full", "Return full customer fields + companyDescription (not just id/name/ytunnus/type)")
        .option("--ids <csv>", "Comma-separated asiakasIds to return (e.g. 1,2,3)")
        .option("--include <csv>", "Expand each row with per-customer arrays: contacts and/or sijainnit (best with --full)")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const ids = typeof opts.ids === "string"
                ? opts.ids.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
                : undefined;
            const include = typeof opts.include === "string"
                ? opts.include.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
                : undefined;
            const result = await runCustomerList(client, {
                limit: opts.limit,
                cursor: opts.cursor,
                full: opts.full,
                ids,
                include,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("get <asiakasId>")
        .description("Get a single customer by asiakasId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runCustomerGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("worksites <asiakasId>")
        .description("List worksites belonging to a customer")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            writeJson(await runCustomerWorksites(client, Number(idStr)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const modulesCmd = c
        .command("modules <asiakasId>")
        .description("Report or toggle a customer's module flags + roolit. Without --set/--unset: read-only report. Field keys: " +
        ALL_FIELD_KEYS.join(", "))
        .option("--set <keys>", "Comma-separated field keys to turn ON (e.g. jerry,weather,pumppu)")
        .option("--unset <keys>", "Comma-separated field keys to turn OFF");
    addWriteFlagsToCommand(modulesCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const asiakasId = Number(idStr);
            if (!opts.set && !opts.unset) {
                writeJson(await runCustomerModulesReport(client, asiakasId));
                return;
            }
            let changes;
            try {
                changes = parseModuleChanges(opts.set, opts.unset);
            }
            catch (validationErr) {
                writeError(validationErr);
                process.exit(4);
            }
            const result = await runCustomerModulesApply(client, asiakasId, changes, {
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
    const operatorCmd = c
        .command("operator <asiakasId>")
        .description("Verify or provision the full operator preset (all 9 operator flags at once). System-admin, cross-tenant. Default (no flag): verify — exit 0 iff all 9 are on, else exit 1.")
        .option("--set", "Turn ALL 9 operator flags ON")
        .option("--reset", "Turn ALL 9 operator flags OFF");
    addWriteFlagsToCommand(operatorCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const asiakasId = Number(idStr);
            if (opts.set && opts.reset) {
                writeError(new Error("--set and --reset are mutually exclusive"));
                process.exit(4);
            }
            if (opts.set || opts.reset) {
                const changes = operatorPresetChanges(!!opts.set);
                const result = await runCustomerModulesApply(client, asiakasId, changes, {
                    dryRun: opts.dryRun,
                    idempotencyKey: opts.idempotencyKey,
                    reason: opts.reason,
                });
                writeJson(result);
                return;
            }
            // Verify (default): report state and gate the exit code on it.
            const result = await runCustomerOperatorVerify(client, asiakasId);
            writeJson(result);
            if (!result.allSet)
                process.exitCode = 1;
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const settingsCmd = c
        .command("settings <asiakasId>")
        .description("Report or toggle ALL asiakasSettings (every canonical ASIAKAS_SETTING_TYPE_IDS name) + pumppu. No --set/--unset = read-only report. Names accept canonical settings (case-insensitive), the 8 module aliases, or pumppu.")
        .option("--set <keys>", "Comma-separated setting names to turn ON")
        .option("--unset <keys>", "Comma-separated setting names to turn OFF");
    addWriteFlagsToCommand(settingsCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const asiakasId = Number(idStr);
            if (!opts.set && !opts.unset) {
                writeJson(await runCustomerSettingsReport(client, asiakasId));
                return;
            }
            let changes;
            try {
                changes = parseSettingChanges(opts.set, opts.unset);
            }
            catch (validationErr) {
                writeError(validationErr);
                process.exit(4);
            }
            writeJson(await runCustomerSettingsApply(client, asiakasId, changes, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("search <query>")
        .description("Free-text search for customers")
        .option("--limit <n>", "Max results", (v) => Math.min(Number(v), 500))
        .action(async (query, opts) => {
        try {
            const client = await getClient();
            const result = await runCustomerSearch(client, query, opts.limit);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("prh [ytunnus]")
        .description("Look up a company in the Finnish business registry (PRH). Positional <ytunnus> for an exact business-ID lookup, or --search <name>.")
        .option("--search <name>", "Search by company name instead of business ID")
        .option("--page <n>", "Result page for --search (default 1)", (v) => Number(v), 1)
        .action(async (ytunnus, opts) => {
        try {
            const client = await getClient();
            if (opts.search) {
                writeJson(await runCustomerPrhSearch(client, opts.search, opts.page));
                return;
            }
            if (!ytunnus) {
                writeError(new Error("provide a business-ID positional or --search <name>"));
                process.exit(4);
            }
            writeJson(await runCustomerPrhById(client, ytunnus));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("history <asiakasId>")
        .description("Change-tracker audit trail for one customer (who changed what, with --reason).")
        .option("--limit <n>", "Max rows (default 100, cap 500)", (v) => Math.min(Number(v), 500), 100)
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runCustomerHistory(client, Number(idStr), opts.limit));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = c
        .command("create")
        .description("Create a customer. Typed flags assemble the createY body (yTunnus required). --from-prh prefills name+yTunnus from the business registry. --body raw JSON overrides the typed flags.")
        .option("--name <s>", "Customer name (asiakasNimi)")
        .option("--ytunnus <s>", "Business ID (yTunnus) — REQUIRED unless --from-prh/--body supplies it")
        .option("--email <s>", "Invoicing email (laskutusEmail)")
        .option("--short-name <s>", "Short display name (asiakasShortNimi)")
        .option("--from-prh <ytunnus>", "Prefill name + yTunnus + billing address from PRH for this business ID")
        .option("--address <s>", "Billing street address (laskutusOsoite)")
        .option("--postal-code <s>", "Billing postal code (laskutusPostinumero)")
        .option("--city <s>", "Billing city (laskutusKaupunki)")
        .option("--get-or-create", "If a customer with this yTunnus already exists, return it (reused:true) instead of creating a duplicate")
        .option("--body <json>", "Raw JSON body forwarded verbatim (overrides typed flags)");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const ownerAsiakasId = await resolveCurrentOwnerAsiakasId(client);
            const prh = opts.fromPrh
                ? await runCustomerPrhById(client, opts.fromPrh)
                : undefined;
            const body = buildAsiakasCreateBody(opts, ownerAsiakasId, prh);
            if (body.yTunnus === undefined || body.yTunnus === null || body.yTunnus === "") {
                writeError(new Error("create requires --ytunnus (or --from-prh / --body with yTunnus)"));
                process.exit(4);
            }
            // --get-or-create: an existing yTunnus isn't a duplicate to recreate —
            // return it (so onboarding is idempotent). >1 match is ambiguous.
            if (opts.getOrCreate) {
                const existing = await runCustomerByYtunnus(client, String(body.yTunnus));
                if (existing.length > 1) {
                    writeError(new Error(`ambiguous: ${existing.length} customers share ytunnus ${body.yTunnus} (ids: ${existing
                        .map((m) => m.asiakasId)
                        .join(", ")}). Use \`ib customer get <id>\`.`));
                    process.exit(4);
                }
                if (existing.length === 1) {
                    writeJson({ ...existing[0], reused: true });
                    return;
                }
            }
            const res = await runCustomerCreate(client, body, opts);
            if (opts.dryRun) {
                writeJson(res);
                return;
            }
            const newId = extractAsiakasId(res);
            const created = newId ? await runCustomerGet(client, newId) : res;
            writeJson(opts.getOrCreate ? { ...created, reused: false } : created);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = c
        .command("update <asiakasId>")
        .description("Update a customer. Reads the current record, overlays the provided flags (preserving everything else — no contact-person clobber), and writes back. --from-prh refreshes name+yTunnus+billing address from the registry (explicit flags still win). --body raw JSON overrides flags.")
        .option("--name <s>", "Customer name (asiakasNimi)")
        .option("--ytunnus <s>", "Business ID (ytunnus)")
        .option("--email <s>", "Invoicing email (laskutusEmail)")
        .option("--short-name <s>", "Short display name (asiakasShortNimi)")
        .option("--comment <s>", "Comment (kommentti)")
        .option("--contact-person <id>", "Single PRIMARY contact personId (asiakasContactPersonId) — for memberships use `customer person add`", (v) => Number(v))
        .option("--type <id>", "Customer type id (asiakasTypeId)", (v) => Number(v))
        .option("--address <s>", "Billing street address (laskutusOsoite)")
        .option("--postal-code <s>", "Billing postal code (laskutusPostinumero)")
        .option("--city <s>", "Billing city (laskutusKaupunki)")
        .option("--from-prh <ytunnus>", "Refresh name + yTunnus + billing address from PRH (explicit flags still win)")
        .option("--body <json>", "Raw JSON body forwarded verbatim (overrides typed flags)");
    addWriteFlagsToCommand(updateCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const asiakasId = Number(idStr);
            const current = await runCustomerGet(client, asiakasId);
            const prh = opts.fromPrh ? await runCustomerPrhById(client, opts.fromPrh) : undefined;
            const body = buildAsiakasUpdateBody(current, opts, prh);
            const res = await runCustomerUpdate(client, asiakasId, body, opts);
            if (opts.dryRun) {
                writeJson(res);
                return;
            }
            // Surface whether the write actually changed anything (vs an idempotent
            // no-op) alongside the re-fetched record.
            const changed = res?.changed ?? null;
            writeJson({ ...(await runCustomerGet(client, asiakasId)), changed });
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const upsertCmd = c
        .command("create-or-update")
        .alias("upsert")
        .description("Upsert a customer keyed by business ID (ytunnus). Looks it up in your tenant " +
        "(system admins: across tenants), then 1 match → update (read-merge with your " +
        "flags), 0 → create, >1 → error. --from-prh <yt> uses that business ID as the key " +
        "AND prefills name+yTunnus+billing address from PRH on create. Returns { ...customer, action }.")
        .option("--ytunnus <s>", "Business ID key (yTunnus) — required unless --from-prh/--body supplies it")
        .option("--from-prh <ytunnus>", "Use this business ID as the key AND prefill from PRH on create")
        .option("--name <s>", "Customer name (asiakasNimi)")
        .option("--email <s>", "Invoicing email (laskutusEmail)")
        .option("--short-name <s>", "Short display name (asiakasShortNimi)")
        .option("--comment <s>", "Comment (kommentti) — applied on update")
        .option("--contact-person <id>", "Contact person id — applied on update", (v) => Number(v))
        .option("--type <id>", "Customer type id — applied on update", (v) => Number(v))
        .option("--address <s>", "Billing street address (laskutusOsoite)")
        .option("--postal-code <s>", "Billing postal code (laskutusPostinumero)")
        .option("--city <s>", "Billing city (laskutusKaupunki)")
        .option("--body <json>", "Raw JSON body forwarded verbatim (overrides typed flags)");
    addWriteFlagsToCommand(upsertCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runCustomerUpsert(client, opts, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            // Caller input errors (no key / ambiguous match) are exit 4; API/network
            // errors keep their contract-mapped codes via exitWithError.
            if (e instanceof Error &&
                (e.message.startsWith("ambiguous:") || e.message.startsWith("create-or-update requires"))) {
                writeError(e);
                process.exit(4);
            }
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(c
        .command("delete <asiakasId>")
        .description("Delete a customer (asiakas). Requires --reason.")).action(async (asiakasIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const ownerAsiakasId = await resolveCurrentOwnerAsiakasId(client);
            const result = await runCustomerDelete(client, Number(asiakasIdStr), ownerAsiakasId, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const customerPerson = c
        .command("person")
        .description("Manage a customer's person MEMBERSHIPS (asiakasPerson) — distinct from the " +
        "single primary contact set via `customer update --contact-person`, and from " +
        "RBAC roles managed via `person role`. See docs: asiakas-contact-person-model.");
    addWriteFlagsToCommand(customerPerson
        .command("add")
        .description("Attach a person to a customer (asiakasPerson). Requires --reason.")
        .requiredOption("--asiakas <id>", "Target asiakasId", Number)
        .requiredOption("--person <id>", "Target personId", Number)
        .option("--contact-type <id>", "contactPersonTypeId — membership link type (1=pumppari [default], 2=order-email recipient, 3=manual, 5=auto-from-keikka)", Number, 1)).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runCustomerPersonAdd(client, { asiakasId: opts.asiakas, personId: opts.person, contactPersonTypeId: opts.contactType }, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(customerPerson
        .command("remove")
        .description("Detach a person from a customer (asiakasPerson). Requires --reason.")
        .requiredOption("--asiakas <id>", "Target asiakasId", Number)
        .requiredOption("--person <id>", "Target personId", Number)
        .option("--contact-type <id>", "contactPersonTypeId — membership link type (1=pumppari [default], 2=order-email recipient, 3=manual, 5=auto-from-keikka)", Number, 1)).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runCustomerPersonRemove(client, { asiakasId: opts.asiakas, personId: opts.person, contactPersonTypeId: opts.contactType }, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    customerPerson
        .command("list <asiakasId>")
        .description("List persons attached to a customer. Optional --role filter.")
        .option("--role <name>", "Filter by role name (e.g. keikkaHandler)")
        .action(async (asiakasIdStr, opts) => {
        try {
            const client = await getClient();
            const result = await runCustomerPersonList(client, Number(asiakasIdStr), opts.role);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
/**
 * Resolve the caller's current `ownerAsiakasId` via the existing
 * `/api/company-selection/available` route. Used by every customer command
 * that needs the active tenant id (create body, history path, delete URL).
 */
async function resolveCurrentOwnerAsiakasId(client) {
    const available = await client.get("/api/company-selection/available");
    return available.currentCompanyId;
}
// `@ibetoni/constants` is a CommonJS package — pulled in via createRequire so
// the ESM build doesn't need a default-export shim.
const cjsRequire = createRequire(import.meta.url);
/**
 * GET /api/asiakas/person/list/:asiakasId/:roleTypeId — returns persons
 * attached to a customer, optionally filtered by role NAME (mapped to its
 * typeId via `ROLE_TYPEID_BY_NAME`).
 *
 * Backend response shape is `{ personList: [...] }` in production. Older
 * cache-warm paths and direct-query paths may return a bare array or the raw
 * mssql wrapper `{ recordset, recordsets, ... }`. Unwrapping defensively
 * accepts any of the three. The flat result is wrapped in the universal
 * `ListEnvelope` so output formatters can render it.
 */
export async function runCustomerPersonList(client, asiakasId, roleName) {
    const typeId = resolveRoleTypeId(roleName);
    // Backend `getAsiakasPersonList` sometimes returns the raw mssql result
    // wrapper `{ recordset, recordsets, ... }` instead of an unwrapped array
    // (depends on cache warmth + middleware path). Unwrap defensively so the
    // CLI is resilient to either shape.
    const raw = await client.get(`/api/asiakas/person/list/${asiakasId}/${typeId}`);
    let rows = [];
    if (Array.isArray(raw)) {
        rows = raw;
    }
    else if (raw && typeof raw === "object") {
        const wrapper = raw;
        rows = wrapper.personList || wrapper.recordset || wrapper.recordsets?.[0] || [];
    }
    const items = rows.map((r) => ({
        personId: r.personId,
        name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
        email: r.personEmail || null,
        role: r.asiakasPersonSettingTypeId || null,
    }));
    return { items, nextCursor: null, count: items.length };
}
//# sourceMappingURL=index.js.map