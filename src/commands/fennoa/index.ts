/**
 * ib fennoa — Fennoa accounting integration (system admin).
 * v1: open PURCHASE invoices (payables) for PumiNet Oy via the backend's
 * live two-phase Fennoa fetch. Server-side requireSystemAdmin is authoritative.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";

interface PurchaseInvoiceRow {
  id: number;
  supplierName: string | null;
  supplierBusinessId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  totalGross: number;
  totalNet: number;
  totalDue: number;
  termsOfPayment: string | null;
  onHold: boolean;
  isReceipt: boolean;
  approvalStatus: string | null;
  paymentStatus: string;
}

interface PurchasesSummary {
  count: number;
  totalDue: number;
  overdueCount: number;
  overdueTotal: number;
  oldestDueDate: string | null;
}

interface PurchasesResponse {
  invoices?: PurchaseInvoiceRow[];
  summary: PurchasesSummary;
  fetchedAt: string;
  asiakasId: number;
  months: number;
  cached?: boolean;
}

/** Build a `?k=v&...` query suffix from defined params (one idiom for all reads). */
function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** GET open purchase invoices (payables) → ListEnvelope + summary. */
export async function runFennoaPurchases(
  client: ApiClient,
  opts: { all?: boolean; months?: number; asiakas?: number; refresh?: boolean }
): Promise<ListEnvelope<PurchaseInvoiceRow> & Omit<PurchasesResponse, "invoices">> {
  const res = await client.get<PurchasesResponse>(
    `/api/admin/fennoa/purchase-invoices${qs({
      open: opts.all ? 0 : undefined,
      months: opts.months,
      asiakas: opts.asiakas,
      refresh: opts.refresh ? 1 : undefined,
    })}`
  );
  const items = res.invoices ?? [];
  return {
    items,
    nextCursor: null,
    count: items.length,
    summary: res.summary,
    fetchedAt: res.fetchedAt,
    asiakasId: res.asiakasId,
    months: res.months,
    ...(res.cached ? { cached: true } : {}),
  };
}

export function registerFennoaCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  const fennoa = parent.command("fennoa").description("Fennoa accounting integration — PumiNet Oy purchase invoices (system admin).");

  fennoa
    .command("purchases")
    .description(
      "Open purchase invoices (payables) fetched live from Fennoa — default target PumiNet Oy (asiakasId 26). System-admin only; result cached 15 min server-side."
    )
    .option("--all", "Include settled invoices in the window, not only open (total_due > 0)")
    .option("--months <n>", "Created-after window in months (default 6, max 12)", (v: string) => Number(v))
    .option("--asiakas <id>", "Target company override (e.g. 8 = Kalle Urho Oy verification path)", (v: string) => Number(v))
    .option("--refresh", "Bypass the server's 15-minute cache")
    .action(async (opts: { all?: boolean; months?: number; asiakas?: number; refresh?: boolean }) => {
      try {
        writeJson(await runFennoaPurchases(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });
}
