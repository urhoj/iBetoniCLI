/**
 * ib fennoa — Fennoa accounting integration (system admin).
 * v1: open PURCHASE invoices (payables) for PumiNet Oy via the backend's
 * live two-phase Fennoa fetch. Server-side requireSystemAdmin is authoritative.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { qs } from "../../api/query.js";
import { jsonAction } from "../_shared/action.js";
import { intFlag } from "../../targets.js";
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
    ...listEnvelope(items),
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
    .option("--all")
    .option("--months <n>", "", intFlag("--months"))
    .option("--asiakas <id>", "", intFlag("--asiakas"))
    .option("--refresh")
    .action(
      jsonAction(getClient, (client, opts: { all?: boolean; months?: number; asiakas?: number; refresh?: boolean }) =>
        runFennoaPurchases(client, opts)
      )
    );
}
