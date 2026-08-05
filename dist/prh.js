import { listEnvelope } from "./api/envelopes.js";
import { qs } from "./api/query.js";
/**
 * GET /api/prh/company/:businessId — single company from the Finnish business
 * registry. Backend wraps as { success, data, timestamp }; unwrap `.data`.
 * 404 (unknown Y-tunnus) → CliError exit 5; invalid format → exit 4.
 */
export async function runPrhById(client, ytunnus) {
    const res = await client.get(`/api/prh/company/${encodeURIComponent(ytunnus)}`);
    return { ...res.data, companySituations: res.data.companySituations ?? [] };
}
/**
 * GET /api/prh/search/name?q=&page= — name search. Backend wraps as
 * { success, data: { companies, totalResults, … }, timestamp }. Project the
 * companies into the universal list envelope.
 */
export async function runPrhSearch(client, name, page = 1) {
    const res = await client.get(`/api/prh/search/name${qs({ q: name, page })}`);
    const companies = res.data?.companies ?? [];
    return listEnvelope(companies.map((c) => ({
        businessId: c.businessId,
        name: c.name,
        city: c.address?.city ?? null,
    })));
}
//# sourceMappingURL=prh.js.map