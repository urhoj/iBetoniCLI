import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";

export interface CustomerListFilter {
  limit?: number;
  cursor?: string;
}

/**
 * GET /api/cli/customer/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runCustomerList(
  client: ApiClient,
  opts: CustomerListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/customer/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/customer/get/:asiakasId. Returns the flat backend record as-is.
 */
export async function runCustomerGet(
  client: ApiClient,
  asiakasId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/customer/get/${asiakasId}`
  );
}

/**
 * GET /api/asiakas/search?q=<query> — existing (non-/api/cli/) route used by
 * the FE customer typeahead. Result shape is whatever the backend returns
 * (typically an array of asiakas records).
 */
export async function runCustomerSearch(
  client: ApiClient,
  query: string
): Promise<unknown> {
  const qs = new URLSearchParams({ q: query }).toString();
  return client.get<unknown>(`/api/asiakas/search?${qs}`);
}

/**
 * Register `ib customer` read subcommands on the parent commander instance:
 *   - list    filterable by --limit/--cursor
 *   - get     single asiakas by id
 *   - search  free-text search (existing /api/asiakas/search route)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerCustomerCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const c = parent.command("customer").description("Customer commands");

  c.command("list")
    .description("List customers")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .option("--cursor <c>", "Pagination cursor")
    .action(async (opts: CustomerListFilter) => {
      try {
        const client = await getClient();
        const result = await runCustomerList(client, opts);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  c.command("get <asiakasId>")
    .description("Get a single customer by asiakasId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runCustomerGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  c.command("search <query>")
    .description("Free-text search for customers")
    .action(async (query: string) => {
      try {
        const client = await getClient();
        const result = await runCustomerSearch(client, query);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });
}
