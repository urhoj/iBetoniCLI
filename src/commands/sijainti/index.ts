import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";

export interface SijaintiListFilter {
  type?: string;
  limit?: number;
}

/**
 * GET /api/cli/sijainti/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runSijaintiList(
  client: ApiClient,
  opts: SijaintiListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/sijainti/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/geocode/sijainti/get/:sijaintiId — existing geocode route (not
 * /api/cli/) reused for v1.0 reads. Returns the flat backend record as-is.
 */
export async function runSijaintiGet(
  client: ApiClient,
  sijaintiId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/geocode/sijainti/get/${sijaintiId}`
  );
}

/**
 * Register `ib sijainti` read subcommands on the parent commander instance:
 *   - list   filterable by --type/--limit
 *   - get    single sijainti by id (uses existing /api/geocode/sijainti route)
 *
 * v1.0 ships read-only; create/update commands come in Phase E.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerSijaintiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const s = parent.command("sijainti").description("Sijainti (location) commands");

  s.command("list")
    .description("List sijainti (locations)")
    .option("--type <t>", "Filter by sijainti type")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .action(async (opts: SijaintiListFilter) => {
      try {
        const client = await getClient();
        const result = await runSijaintiList(client, opts);
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });

  s.command("get <sijaintiId>")
    .description("Get a single sijainti by sijaintiId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runSijaintiGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    });
}
