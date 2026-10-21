import { listEnvelope } from "./api/envelopes.js";
import { qs } from "./api/query.js";
import { failUsage } from "./output/json.js";
// The backend's own rule (prhService.validateBusinessId). A company NAME passed here
// got only "Invalid business ID format" back, with no way to find the id (fb#2685).
const BUSINESS_ID = /^\d{7,8}-\d$/;
const EXAMPLE_ID = "0112038-9";
/** Y-tunnus check digit (weights 7,9,10,5,8,4,2, mod 11); an 8-digit body is the zero-padded 7-digit form. */
function checkDigitOk(body, check) {
    const b = body.length === 8 && body.startsWith("0") ? body.slice(1) : body;
    if (b.length !== 7)
        return false;
    const r = [7, 9, 10, 5, 8, 4, 2].reduce((sum, w, i) => sum + w * Number(b[i]), 0) % 11;
    return r !== 1 && (r === 0 ? 0 : 11 - r) === Number(check);
}
/**
 * Return the trimmed business ID, or exit 4. Digit-only input (once
 * spaces/hyphens and a VAT "FI" prefix are dropped) gets a format hint, naming
 * the corrected ID only when its check digit holds (01120389, FI01120389 →
 * 0112038-9); input with letters is treated as a name (fb#2692, fb#2747).
 */
export function assertBusinessId(raw) {
    const input = raw.trim();
    if (BUSINESS_ID.test(input))
        return input;
    const digits = input.replace(/^FI/i, "").replace(/[\s-]/g, "");
    const body = digits.slice(0, -1);
    const check = digits.slice(-1);
    const format = "format is 7-8 digits, hyphen, check digit";
    const hint = /^\d{8,9}$/.test(digits) && checkDigitOk(body, check)
        ? `${format} — did you mean ${body}-${check}?`
        : /^\d*$/.test(digits)
            ? `${format}, e.g. ${EXAMPLE_ID}`
            : `find it by name: ib opendata prh --search "${input.replace(/"/g, "")}"`;
    return failUsage(`"${input}" is not a business ID (Y-tunnus, e.g. ${EXAMPLE_ID})`, hint);
}
/**
 * GET /api/prh/company/:businessId — single company from the Finnish business
 * registry. Backend wraps as { success, data, timestamp }; unwrap `.data`.
 * 404 (unknown Y-tunnus) → CliError exit 5; invalid format → exit 4.
 */
export async function runPrhById(client, ytunnus) {
    const id = assertBusinessId(ytunnus);
    const res = await client.get(`/api/prh/company/${encodeURIComponent(id)}`);
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