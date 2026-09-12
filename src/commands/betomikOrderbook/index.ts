import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { type WriteFlags, writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { addJsonBodyOptions, resolveJsonBody, type JsonBodyFlags } from "../_shared/jsonBody.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { writeJson } from "../../output/json.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { parseId } from "../../targets.js";

export async function runBetomikOrderbookImport(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/betomik-orderbook/import", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface BetomikRunRow {
  importRunId: number;
  sheetLabel: string;
  isoYear: number;
  isoWeek: number;
  importedAt?: string;
  importedBy?: number | null;
  rowCount: number;
}

function itemsOf<T>(raw: unknown): T[] {
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/** Import runs for the Betomik staging table, newest first (GET /api/betomik-orderbook/runs). */
export async function runBetomikOrderbookRuns(client: ApiClient): Promise<ListEnvelope<BetomikRunRow>> {
  const raw = await client.get<unknown>("/api/betomik-orderbook/runs");
  return listEnvelope(itemsOf<BetomikRunRow>(raw));
}

/** Staging rows of one import run (GET /api/betomik-orderbook/runs/:runId/rows). */
export async function runBetomikOrderbookRows(
  client: ApiClient,
  runId: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  const raw = await client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/rows`);
  return listEnvelope(itemsOf<Record<string, unknown>>(raw));
}

export function registerBetomikOrderbookCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const group = parent
    .command("betomik-orderbook")
    .description("Betomik order-book import validator staging (developer only)");

  const importCmd = addJsonBodyOptions(group.command("import"));
  addWriteFlagsToCommand(importCmd).action(
    guarded(async (opts: WriteFlags & JsonBodyFlags) => {
      const body = resolveJsonBody(importCmd, opts, { required: true });
      const client = await getClient();
      const result = await runBetomikOrderbookImport(client, body as Record<string, unknown>, opts);
      writeJson(result);
    })
  );

  group
    .command("runs")
    .description("List import runs (sheet label, ISO year/week, row count), newest first")
    .action(jsonAction(getClient, (client) => runBetomikOrderbookRuns(client)));

  group
    .command("rows <runId>")
    .description("Staging rows of one import run (plate, driver, source type, m3, review status)")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookRows(client, parseId(idStr, "runId"))
      )
    );
}
