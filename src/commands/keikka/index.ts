import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";

export interface KeikkaListFilter {
  from?: string;
  to?: string;
  customer?: number;
  vehicle?: number;
  status?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Resolve `today`, `yesterday`, `tomorrow` to an ISO `YYYY-MM-DD` date
 * (local time). Any other input — including already-formatted dates — is
 * returned unchanged so the backend's validator gets the final say.
 */
export function resolveDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input === "today" || input === "yesterday" || input === "tomorrow") {
    const d = new Date();
    if (input === "yesterday") d.setDate(d.getDate() - 1);
    if (input === "tomorrow") d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return input;
}

/**
 * GET /api/cli/keikka/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runKeikkaList(
  client: ApiClient,
  opts: KeikkaListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.customer !== undefined) params.set("customer", String(opts.customer));
  if (opts.vehicle !== undefined) params.set("vehicle", String(opts.vehicle));
  if (opts.status) params.set("status", opts.status);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/keikka/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/keikka/get/:keikkaId. Returns the flat backend record as-is.
 */
export async function runKeikkaGet(
  client: ApiClient,
  keikkaId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/keikka/get/${keikkaId}`
  );
}

/**
 * Register `ib keikka` read subcommands on the parent commander instance:
 *   - list   filterable by --from/--to/--customer/--vehicle/--status/--limit/--cursor
 *   - get    single keikka by id
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerKeikkaCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const k = parent.command("keikka").description("Keikka commands");

  k.command("list")
    .description("List keikkas matching the filters")
    .option("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .option("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .option("--customer <id>", "Filter by asiakasId", (v: string) => Number(v))
    .option("--vehicle <id>", "Filter by vehicleId", (v: string) => Number(v))
    .option("--status <s>", "Filter by status")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .option("--cursor <c>", "Pagination cursor")
    .action(async (opts: KeikkaListFilter) => {
      try {
        const client = await getClient();
        const resolved: KeikkaListFilter = {
          ...opts,
          from: resolveDate(opts.from),
          to: resolveDate(opts.to),
        };
        const result = await runKeikkaList(client, resolved);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  k.command("get <keikkaId>")
    .description("Get a single keikka by id")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runKeikkaGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });
}
