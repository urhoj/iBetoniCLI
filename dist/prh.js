import { listEnvelope } from "./api/envelopes.js";
import { qs } from "./api/query.js";
import { failUsage } from "./output/json.js";
// The backend's own rule (prhService.validateBusinessId). A company NAME passed here
// got only "Invalid business ID format" back, with no way to find the id (fb#2685).
const BUSINESS_ID = /^\d{7,8}-\d$/;
/**
 * GET /api/prh/company/:businessId — single company from the Finnish business
 * registry. Backend wraps as { success, data, timestamp }; unwrap `.data`.
 * 404 (unknown Y-tunnus) → CliError exit 5; invalid format → exit 4.
 */
export async function runPrhById(client, ytunnus) {
    if (!BUSINESS_ID.test(ytunnus)) {
        failUsage(`"${ytunnus}" is not a business ID (Y-tunnus, e.g. 0145937-9)`, `find it by name: ib opendata prh --search "${ytunnus}"`);
    }
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