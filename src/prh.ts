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

/**
 * Exit 4 unless `input` is a business ID. Digit-only input (once spaces/hyphens
 * and a VAT "FI" prefix are dropped) gets a format hint, plus the corrected ID
 * when it has the right length (01459379, FI01459379 → 0145937-9); anything
 * else is treated as a name (fb#2692).
 */
export function assertBusinessId(input: string): void {
  if (BUSINESS_ID.test(input)) return;
  const digits = input.trim().replace(/^FI/i, "").replace(/[\s-]/g, "");
  const format = "format is 7-8 digits, hyphen, check digit";
  const hint = /^\d{8,9}$/.test(digits)
    ? `${format} — did you mean ${digits.slice(0, -1)}-${digits.slice(-1)}?`
    : /^\d+$/.test(digits)
      ? `${format}, e.g. 0145937-9`
      : `find it by name: ib opendata prh --search "${input}"`;
  failUsage(`"${input}" is not a business ID (Y-tunnus, e.g. 0145937-9)`, hint);
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
  assertBusinessId(ytunnus);
  const res = await client.get<{ data: PrhCompany }>(
    `/api/prh/company/${encodeURIComponent(ytunnus)}`
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
