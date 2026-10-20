import { listEnvelope } from "./api/envelopes.js";
import { qs } from "./api/query.js";
import { failUsage } from "./output/json.js";
// The backend's own rule (prhService.validateBusinessId). A company NAME passed here
// got only "Invalid business ID format" back, with no way to find the id (fb#2685).
const BUSINESS_ID = /^\d{7,8}-\d$/;
/**
 * Exit 4 unless `input` is a business ID. Digit-only input (once spaces/hyphens
 * and a VAT "FI" prefix are dropped) gets a format hint, plus the corrected ID
 * when it has the right length (01459379, FI01459379 → 0145937-9); anything
 * else is treated as a name (fb#2692).
 */
export function assertBusinessId(input) {
    if (BUSINESS_ID.test(input))
        return;
    const digits = input.trim().replace(/^FI/i, "").replace(/[\s-]/g, "");
    const format = "format is 7-8 digits, hyphen, check digit";
    const hint = /^\d{8,9}$/.test(digits)
        ? `${format} — did you mean ${digits.slice(0, -1)}-${digits.slice(-1)}?`
        : /^\d+$/.test(digits)
            ? `${format}, e.g. 0145937-9`
            : `find it by name: ib opendata prh --search "${input}"`;
    failUsage(`"${input}" is not a business ID (Y-tunnus, e.g. 0145937-9)`, hint);
}
/**
 * GET /api/prh/company/:businessId — single company from the Finnish business
 * registry. Backend wraps as { success, data, timestamp }; unwrap `.data`.
 * 404 (unknown Y-tunnus) → CliError exit 5; invalid format → exit 4.
 */
export async function runPrhById(client, ytunnus) {
    assertBusinessId(ytunnus);
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