/**
 * PRH (Finnish business registry / avoindata.prh.fi) lookups — shared.
 *
 * Open-data company lookups used by two surfaces:
 *  - `ib opendata prh` (canonical command), and
 *  - `ib customer` (the `--from-prh` prefill on create/update, plus the hidden
 *    `ib customer prh` back-compat alias).
 *
 * Backend routes (`/api/prh/*`) are unchanged; this module only owns the
 * client-side request/transform so both command surfaces share one source.
 */
import type { ApiClient } from "./api/client.js";
import { listEnvelope, type ListEnvelope } from "./api/envelopes.js";
import { qs } from "./api/query.js";
import { failUsage } from "./output/json.js";

// The backend's own rule (prhService.validateBusinessId). A company NAME passed here
// got only "Invalid business ID format" back, with no way to find the id (fb#2685).
const BUSINESS_ID = /^\d{7,8}-\d$/;
const EXAMPLE_ID = "0112038-9";

/** Y-tunnus check digit (weights 7,9,10,5,8,4,2, mod 11); an 8-digit body is the zero-padded 7-digit form. */
function checkDigitOk(body: string, check: string): boolean {
  const b = body.length === 8 && body.startsWith("0") ? body.slice(1) : body;
  if (b.length !== 7) return false;
  const r = [7, 9, 10, 5, 8, 4, 2].reduce((sum, w, i) => sum + w * Number(b[i]), 0) % 11;
  return r !== 1 && (r === 0 ? 0 : 11 - r) === Number(check);
}

/**
 * Return the trimmed business ID, or exit 4. Digit-only input (once
 * spaces/hyphens and a VAT "FI" prefix are dropped) gets a format hint, naming
 * the corrected ID only when its check digit holds (01120389, FI01120389 →
 * 0112038-9); input with letters is treated as a name (fb#2692, fb#2747).
 */
export function assertBusinessId(raw: string): string {
  const input = raw.trim();
  if (BUSINESS_ID.test(input)) return input;
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

/** Flat PRH company shape (mirrors backend formatCompanyData). */
export interface PrhCompany {
  businessId: string | null;
  name: string | null;
  tradeNames: string[];
  address: { street: string | null; postCode: string | null; city: string | null; full: string | null } | null;
  companyForm: { type?: string; name?: string } | null;
  status: string | null;
  companySituations: Array<{ type?: string; [k: string]: unknown }>;
  /**
   * Which registry answered. "vies" means PRH had nothing and the backend fell
   * back to the EU VAT register — the only way a SOLE TRADER (toiminimi)
   * resolves, since PRH open data excludes them as personal data. Such a record
   * carries no companyForm/status and an EMPTY companySituations, so a
   * bankruptcy check reads "clear" for the wrong reason; and its `name` is the
   * owner's personal name ("Owner Name / TRADENAME").
   */
  source?: "prh" | "vies";
}

/**
 * GET /api/prh/company/:businessId — single company from the Finnish business
 * registry. Backend wraps as { success, data, timestamp }; unwrap `.data`.
 * 404 (unknown Y-tunnus) → CliError exit 5; invalid format → exit 4.
 */
export async function runPrhById(
  client: ApiClient,
  ytunnus: string
): Promise<PrhCompany> {
  const id = assertBusinessId(ytunnus);
  const res = await client.get<{ data: PrhCompany }>(
    `/api/prh/company/${encodeURIComponent(id)}`
  );
  return { ...res.data, companySituations: res.data.companySituations ?? [] };
}

/**
 * GET /api/prh/search/name?q=&page= — name search. Backend wraps as
 * { success, data: { companies, totalResults, … }, timestamp }. Project the
 * companies into the universal list envelope.
 */
export async function runPrhSearch(
  client: ApiClient,
  name: string,
  page = 1
): Promise<ListEnvelope<{ businessId: string | null; name: string | null; city: string | null }>> {
  const res = await client.get<{ data: { companies: PrhCompany[] } }>(
    `/api/prh/search/name${qs({ q: name, page })}`
  );
  const companies = res.data?.companies ?? [];
  return listEnvelope(
    companies.map((c) => ({
      businessId: c.businessId,
      name: c.name,
      city: c.address?.city ?? null,
    }))
  );
}
