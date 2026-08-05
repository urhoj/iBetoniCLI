import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { writeJson } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { CliError } from "../../api/errors.js";
import { qs } from "../../api/query.js";
import { cappedInt } from "../../targets.js";

export interface SchemaListFilter {
  search?: string;
  limit?: number;
}

type Envelope = ListEnvelope<Record<string, unknown>>;
type Record_ = Record<string, unknown>;

function listQuery(path: string, opts: SchemaListFilter): string {
  return `${path}${qs({ search: opts.search || undefined, limit: opts.limit })}`;
}

export async function runSchemaTables(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return client.get<Envelope>(listQuery("/api/cli/schema/tables", opts));
}
export async function runSchemaViews(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return client.get<Envelope>(listQuery("/api/cli/schema/views", opts));
}
export async function runSchemaProcs(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return client.get<Envelope>(listQuery("/api/cli/schema/procs", opts));
}
export async function runSchemaTable(client: ApiClient, name: string): Promise<Record_> {
  return client.get<Record_>(`/api/cli/schema/table/${name}`);
}
export async function runSchemaView(client: ApiClient, name: string): Promise<Record_> {
  return client.get<Record_>(`/api/cli/schema/view/${name}`);
}
export async function runSchemaProc(client: ApiClient, name: string): Promise<Record_> {
  return client.get<Record_>(`/api/cli/schema/proc/${name}`);
}
export async function runSchemaDump(client: ApiClient): Promise<Record_> {
  return client.get<Record_>("/api/cli/schema/dump");
}

/**
 * Batch the single-object lookups (`table`/`view`/`proc`) — the comma-separated
 * path (feedback #109). Fans out the SAME single-object `run*` function in
 * parallel so each name's path lives in exactly one place. Mirrors
 * `runGlossaryLookupBatch`: a 404 for one name is swallowed to
 * `{ found: false, object: null }` so the batch always resolves; any non-404
 * error still throws. Caller dedupes names before this is reached.
 */
export async function runSchemaBatch(
  client: ApiClient,
  single: (c: ApiClient, name: string) => Promise<Record_>,
  names: string[]
): Promise<ListEnvelope<{ name: string; found: boolean; object: Record_ | null }>> {
  const items = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, found: true, object: await single(client, name) };
      } catch (e) {
        if (e instanceof CliError && e.statusCode === 404) return { name, found: false, object: null };
        throw e;
      }
    })
  );
  return listEnvelope(items);
}

/**
 * Register `ib schema` subcommands. Read-only resource (no write-safety flags).
 * Requires developer access server-side (isSystemAdmin or isDeveloper) — a
 * non-developer gets 403 → exit code 3.
 */
export function registerSchemaCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const s = parent.command("schema", { hidden: !!opts.hidden }).description("SQL schema introspection (developer-only)");

  const listOpt = (cmd: Command) =>
    cmd
      .option("--search <substr>", "Filter object names by substring")
      .option("--limit <n>", "Max rows (default 200, max 1000)", cappedInt(1000));

  // Single object by default; a comma in <name> switches to batch mode
  // (`ib dev schema proc a,b,c`) — parallel fan-out, deduped, 404-tolerant.
  const runOneOrBatch = (fn: (c: ApiClient, name: string) => Promise<Record_>) =>
    guarded(async (name: string) => {
      const client = await getClient();
      if (name.includes(",")) {
        const names = [...new Set(name.split(",").map((n) => n.trim()).filter(Boolean))];
        writeJson(await runSchemaBatch(client, fn, names));
      } else {
        writeJson(await fn(client, name));
      }
    });

  listOpt(s.command("tables")).action(jsonAction(getClient, runSchemaTables));
  listOpt(s.command("views")).action(jsonAction(getClient, runSchemaViews));
  listOpt(s.command("procs")).action(
    jsonAction(getClient, runSchemaProcs)
  );

  s.command("table <name>")
    .action(runOneOrBatch(runSchemaTable));
  s.command("view <name>")
    .action(runOneOrBatch(runSchemaView));
  s.command("proc <name>")
    .action(runOneOrBatch(runSchemaProc));

  s.command("dump")
    .action(jsonAction(getClient, runSchemaDump));
}
