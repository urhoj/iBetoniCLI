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

export interface BetomikReviewBody {
  status: string;
  rowKind?: string;
  palkkiType?: string;
  notes?: string;
}

/** Review one staging row (POST /api/betomik-orderbook/rows/:rowId/review). */
export async function runBetomikOrderbookReview(
  client: ApiClient,
  rowId: number,
  body: BetomikReviewBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/betomik-orderbook/rows/${rowId}/review`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** Run the AI proposer over one run (POST /api/betomik-orderbook/runs/:runId/propose). */
export async function runBetomikOrderbookPropose(
  client: ApiClient,
  runId: number,
  body: { provider?: string; force?: boolean },
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/betomik-orderbook/runs/${runId}/propose`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** AI-vs-human agreement for one run (GET /api/betomik-orderbook/runs/:runId/ai-stats). */
export async function runBetomikOrderbookAiStats(client: ApiClient, runId: number): Promise<unknown> {
  return client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/ai-stats`);
}

/** Sync a Betomik order-book payload to keikka/palkki rows (POST /api/betomik-orderbook/sync). */
export async function runBetomikOrderbookSync(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/betomik-orderbook/sync", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** Re-run sync for an already-imported run (POST /api/betomik-orderbook/runs/:runId/sync). */
export async function runBetomikOrderbookResync(
  client: ApiClient,
  runId: number,
  body: { mode?: string; provider?: string },
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/betomik-orderbook/runs/${runId}/sync`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** Extraction prompt template used by the AI cell extractor (GET /api/betomik-orderbook/extract-prompt). */
export async function runBetomikOrderbookExtractPrompt(client: ApiClient): Promise<unknown> {
  return client.get<unknown>("/api/betomik-orderbook/extract-prompt");
}

/** Blocked/exception rows of one sync run (GET /api/betomik-orderbook/runs/:runId/exceptions). */
export async function runBetomikOrderbookExceptions(
  client: ApiClient,
  runId: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  const raw = await client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/exceptions`);
  return listEnvelope(itemsOf<Record<string, unknown>>(raw));
}

export interface BetomikAuditRow {
  auditId: number;
  /** The ledger row whose sync created this entity — the join back to `rows`/`exceptions`. */
  importRowId: number | null;
  entity: string;
  entityId: number;
  label: string;
  createdAt: string;
  digestedAt: string | null;
}

/** Sync audit trail (entities written/digested), optionally since a given ISO timestamp (GET /api/betomik-orderbook/audit). */
export async function runBetomikOrderbookAudit(
  client: ApiClient,
  { since }: { since?: string }
): Promise<ListEnvelope<BetomikAuditRow>> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const raw = await client.get<unknown>(`/api/betomik-orderbook/audit${qs}`);
  return listEnvelope(itemsOf<BetomikAuditRow>(raw));
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

  const reviewCmd = group
    .command("review <rowId>")
    .description("Review one staging row: set status, optionally override keikka/palkki + palkki type")
    .requiredOption("--status <status>", "pending | approved | rejected")
    .option("--row-kind <kind>", "keikka | palkki")
    .option("--palkki-type <name>", "one of the tenant's grid_palkkiTypes names")
    .option("--note <text>", "reviewNotes");
  addWriteFlagsToCommand(reviewCmd).action(
    guarded(
      async (
        idStr: string,
        opts: WriteFlags & { status: string; rowKind?: string; palkkiType?: string; note?: string }
      ) => {
        const client = await getClient();
        const body: BetomikReviewBody = { status: opts.status };
        if (opts.rowKind) body.rowKind = opts.rowKind;
        if (opts.palkkiType) body.palkkiType = opts.palkkiType;
        if (opts.note) body.notes = opts.note;
        writeJson(await runBetomikOrderbookReview(client, parseId(idStr, "rowId"), body, opts));
      }
    )
  );

  const proposeCmd = group
    .command("propose <runId>")
    .description("Run the AI proposer over one run (stores a proposal per row in aiJson)")
    .option("--provider <name>", "bedrock (default) | local")
    .option("--force", "Re-propose rows that already carry a proposal");
  addWriteFlagsToCommand(proposeCmd).action(
    guarded(async (idStr: string, opts: WriteFlags & { provider?: string; force?: boolean }) => {
      const client = await getClient();
      const body: { provider?: string; force?: boolean } = {};
      if (opts.provider) body.provider = opts.provider;
      if (opts.force) body.force = true;
      writeJson(await runBetomikOrderbookPropose(client, parseId(idStr, "runId"), body, opts));
    })
  );

  group
    .command("ai-stats <runId>")
    .description("AI-vs-human agreement for one run's approved rows")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookAiStats(client, parseId(idStr, "runId"))
      )
    );

  const syncCmd = addJsonBodyOptions(group.command("sync"))
    .option("--mode <mode>", "shadow (default) | create | full")
    .option("--provider <name>", "bedrock (default) | local")
    .option(
      "--digest",
      "Send the daily digest e-mail to the owner after the sync and stamp the included audit rows as digested — a real side effect, not a response field"
    );
  addWriteFlagsToCommand(syncCmd).action(
    guarded(
      async (
        opts: WriteFlags & JsonBodyFlags & { mode?: string; provider?: string; digest?: boolean }
      ) => {
        const jsonBody = resolveJsonBody(syncCmd, opts, { required: true });
        const body: Record<string, unknown> = {
          ...jsonBody,
          ...(opts.mode && { mode: opts.mode }),
          ...(opts.provider && { provider: opts.provider }),
          ...(opts.digest && { digest: true }),
        };
        const client = await getClient();
        writeJson(await runBetomikOrderbookSync(client, body, opts));
      }
    )
  );

  const resyncCmd = group
    .command("resync <runId>")
    .description("Re-run sync for an already-imported run without re-importing rows")
    .option("--mode <mode>", "shadow (default) | create | full")
    .option("--provider <name>", "bedrock (default) | local");
  addWriteFlagsToCommand(resyncCmd).action(
    guarded(async (idStr: string, opts: WriteFlags & { mode?: string; provider?: string }) => {
      const client = await getClient();
      const body: { mode?: string; provider?: string } = {};
      if (opts.mode) body.mode = opts.mode;
      if (opts.provider) body.provider = opts.provider;
      writeJson(await runBetomikOrderbookResync(client, parseId(idStr, "runId"), body, opts));
    })
  );

  group
    .command("extract-prompt")
    .description("Extraction prompt template used by the AI cell extractor (system, schema, cells, toolName)")
    .action(jsonAction(getClient, (client) => runBetomikOrderbookExtractPrompt(client)));

  group
    .command("exceptions <runId>")
    .description("Blocked/exception rows from one sync run")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookExceptions(client, parseId(idStr, "runId"))
      )
    );

  group
    .command("audit")
    .description("Sync audit trail (entities written/digested), optionally since a given ISO timestamp")
    .option("--since <iso>", "Only rows created at/after this ISO timestamp")
    .action(
      jsonAction(getClient, (client, opts: { since?: string }) =>
        runBetomikOrderbookAudit(client, { since: opts.since })
      )
    );
}
