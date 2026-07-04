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
import type { ListEnvelope } from "./api/envelopes.js";

/** Flat PRH company shape (mirrors backend formatCompanyData). */
export interface PrhCompany {
  businessId: string | null;
  name: string | null;
  tradeNames: string[];
  address: { street: string | null; postCode: string | null; city: string | null; full: string | null } | null;
  companyForm: { type?: string; name?: string } | null;
  status: string | null;
  companySituations: Array<{ type?: string; [k: string]: unknown }>;
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
  const qs = new URLSearchParams({ q: name, page: String(page) }).toString();
  const res = await client.get<{ data: { companies: PrhCompany[] } }>(
    `/api/prh/search/name?${qs}`
  );
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
