import { writeJson, exitWithError } from "../../output/json.js";
import { CliError } from "../../api/errors.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { runCustomerSearch } from "../customer/index.js";
import { runPersonSearch } from "../person/index.js";
import { runWorksiteSearch } from "../worksite/index.js";
import { runVehicleSearch } from "../vehicle/index.js";
import { runKeikkaSearch } from "../keikka/index.js";
/** Canonical entity order — also the within-tier sort order of merged hits. */
export const SEARCH_ENTITIES = ["customer", "worksite", "person", "vehicle", "keikka"];
const DEFAULT_LIMIT = 5;
/** Parse `--in customer,person`; undefined → all. Unknown name → exit 4. */
export function parseEntityFilter(input) {
    if (!input)
        return [...SEARCH_ENTITIES];
    const wanted = input.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const w of wanted) {
        if (!SEARCH_ENTITIES.includes(w)) {
            throw new CliError(`Unknown entity "${w}" — valid: ${SEARCH_ENTITIES.join(", ")}`, 0, null, 4);
        }
    }
    return SEARCH_ENTITIES.filter((e) => wanted.includes(e));
}
/* ── per-entity projectors (pure, best-effort fields) ───────────────────── */
function projectCustomer(rows) {
    const arr = Array.isArray(rows) ? rows : [];
    return arr.map((r) => ({
        entity: "customer",
        id: Number(r.asiakasId),
        asiakasId: Number(r.asiakasId),
        label: r.asiakasNimi ?? null,
        detail: r.ytunnus ?? null,
    }));
}
function projectPersons(items) {
    return items.map((p) => ({
        entity: "person",
        id: p.personId,
        personId: p.personId,
        label: p.name || null,
        detail: p.phone ?? p.email ?? null,
    }));
}
function projectWorksites(items) {
    return items.map((w) => ({
        entity: "worksite",
        id: w.tyomaaId,
        tyomaaId: w.tyomaaId,
        label: w.name ?? w.address ?? null,
        detail: w.formattedAddress ?? [w.address, w.city].filter(Boolean).join(", ") ?? null,
    }));
}
/**
 * Vehicle projector with a defensive client-side query filter: the backend
 * `?search=` param is deploy-gated and silently ignored pre-deploy (the whole
 * fleet would come back). Matching mirrors the backend: plate/name/typeName
 * case-insensitive substring.
 */
function projectVehicles(items, query) {
    const q = query.toLowerCase();
    return items
        .filter((v) => [v.plate, v.name, v.typeName].some((f) => typeof f === "string" && f.toLowerCase().includes(q)))
        .map((v) => ({
        entity: "vehicle",
        id: Number(v.vehicleId),
        vehicleId: Number(v.vehicleId),
        label: [v.plate, v.name].filter(Boolean).join(" ") || null,
        detail: v.typeName ?? null,
    }));
}
function projectKeikkas(items) {
    return items.map((k) => ({
        entity: "keikka",
        id: k.keikkaId,
        keikkaId: k.keikkaId,
        label: k.title ?? `keikka ${k.keikkaId}`,
        detail: [k.pumppuAika, k.customerName].filter(Boolean).join(" · ") || null,
    }));
}
/* ── fan-out + merge ────────────────────────────────────────────────────── */
/** Items from a list envelope, defensively. */
function envItems(env) {
    return Array.isArray(env?.items)
        ? (env.items)
        : [];
}
/** Dispatch a source's raw result to its projector (accepts native row shapes). */
function projectFor(entity, value, query) {
    switch (entity) {
        case "customer": return projectCustomer(value);
        case "person": return projectPersons(envItems(value));
        case "worksite": return projectWorksites(envItems(value));
        case "vehicle": return projectVehicles(envItems(value), query);
        case "keikka": return projectKeikkas(envItems(value));
    }
}
/**
 * Fan out to the selected entity sources in parallel and merge.
 * Sources return raw entity shapes — `projectFor` is the single projection point.
 */
export async function runUnifiedSearch(query, rawSources, entities = [...SEARCH_ENTITIES]) {
    const selected = SEARCH_ENTITIES.filter((e) => entities.includes(e));
    const settled = await Promise.allSettled(selected.map((e) => rawSources[e]()));
    const items = [];
    const errors = [];
    let firstFailure = null;
    settled.forEach((res, i) => {
        const entity = selected[i];
        if (res.status === "rejected") {
            if (firstFailure === null)
                firstFailure = res.reason;
            errors.push({
                entity,
                message: res.reason instanceof Error ? res.reason.message : String(res.reason),
            });
            return;
        }
        items.push(...projectFor(entity, res.value, query));
    });
    if (items.length === 0 && errors.length === selected.length && firstFailure !== null) {
        throw firstFailure; // every entity failed — surface the first error (mapped exit code)
    }
    const q = query.toLowerCase();
    const tier = (h) => (h.label?.toLowerCase().startsWith(q) ? 0 : 1);
    const order = (h) => SEARCH_ENTITIES.indexOf(h.entity);
    items.sort((a, b) => tier(a) - tier(b) || order(a) - order(b));
    return { items, nextCursor: null, count: items.length, errors };
}
/**
 * Build the real per-entity sources for a client. Returns RAW results so
 * `projectFor` in `runUnifiedSearch` is the single projection point.
 */
export function buildSearchSources(client, query, limit) {
    return {
        customer: () => runCustomerSearch(client, query, limit),
        worksite: () => runWorksiteSearch(client, query, limit),
        person: () => runPersonSearch(client, query, limit),
        vehicle: () => runVehicleSearch(client, query, limit),
        keikka: async () => {
            const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken());
            return runKeikkaSearch(client, query, ownerAsiakasId, limit);
        },
    };
}
/* ── Commander wiring ───────────────────────────────────────────────────── */
/**
 * Register `ib search` — read-only cross-entity unified search. Client-side
 * fan-out over the existing per-entity search endpoints; no backend changes.
 */
export function registerSearchCommands(parent, getClient) {
    parent
        .command("search <query>")
        .description("Cross-entity search: customers, worksites, persons, vehicles, keikkas (one flat ranked list)")
        .option("--in <entities>", `Comma-separated subset of: ${SEARCH_ENTITIES.join(",")}`)
        .option("--limit <n>", "Max hits per entity", (v) => Number(v), DEFAULT_LIMIT)
        .action(async (query, opts) => {
        try {
            const entities = parseEntityFilter(opts.in);
            const client = await getClient();
            const srcs = buildSearchSources(client, query, opts.limit);
            const result = await runUnifiedSearch(query, srcs, entities);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map