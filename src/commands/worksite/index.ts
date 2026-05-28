import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";

export interface WorksiteListFilter {
  limit?: number;
  cursor?: string;
}

/**
 * GET /api/cli/worksite/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runWorksiteList(
  client: ApiClient,
  opts: WorksiteListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/worksite/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/worksite/get/:tyomaaId. Returns the flat backend record as-is.
 */
export async function runWorksiteGet(
  client: ApiClient,
  tyomaaId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/worksite/get/${tyomaaId}`
  );
}

/**
 * POST /api/tyomaa/search — existing (non-/api/cli/) route used by the FE
 * worksite typeahead. Body is `{ q: <query> }`. Result shape is whatever the
 * backend returns (typically an array of tyomaa records).
 */
export async function runWorksiteSearch(
  client: ApiClient,
  query: string
): Promise<unknown> {
  return client.post<unknown>("/api/tyomaa/search", { q: query });
}

/**
 * Register `ib worksite` read subcommands on the parent commander instance:
 *   - list    filterable by --limit/--cursor
 *   - get     single tyomaa by id
 *   - search  free-text search (existing POST /api/tyomaa/search route)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerWorksiteCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const w = parent.command("worksite").description("Worksite commands");

  w.command("list")
    .description("List worksites")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .option("--cursor <c>", "Pagination cursor")
    .action(async (opts: WorksiteListFilter) => {
      try {
        const client = await getClient();
        const result = await runWorksiteList(client, opts);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  w.command("get <tyomaaId>")
    .description("Get a single worksite by tyomaaId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runWorksiteGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  w.command("search <query>")
    .description("Free-text search for worksites")
    .action(async (query: string) => {
      try {
        const client = await getClient();
        const result = await runWorksiteSearch(client, query);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });
}
