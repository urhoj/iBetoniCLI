import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError } from "../../output/json.js";

export interface SchemaListFilter {
  search?: string;
  limit?: number;
}

type Envelope = ListEnvelope<Record<string, unknown>>;
type Record_ = Record<string, unknown>;

function listQuery(path: string, opts: SchemaListFilter): string {
  const params = new URLSearchParams();
  if (opts.search) params.set("search", opts.search);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}`;
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
 * Register `ib schema` subcommands. Read-only resource (no write-safety flags).
 * Requires developer access server-side (isSystemAdmin or isDeveloper) — a
 * non-developer gets 403 → exit code 3.
 */
export function registerSchemaCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const s = parent.command("schema").description("SQL schema introspection (developer-only)");

  const listOpt = (cmd: Command) =>
    cmd
      .option("--search <substr>", "Filter object names by substring")
      .option("--limit <n>", "Max rows (default 200, max 1000)", (v: string) => Math.min(Number(v), 1000));

  const runList =
    (fn: (c: ApiClient, o: SchemaListFilter) => Promise<Envelope>) =>
    async (opts: SchemaListFilter) => {
      try {
        writeJson(await fn(await getClient(), opts));
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    };

  const runOne =
    (fn: (c: ApiClient, name: string) => Promise<Record_>) => async (name: string) => {
      try {
        writeJson(await fn(await getClient(), name));
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    };

  const runZero =
    (fn: (c: ApiClient) => Promise<Record_>) => async () => {
      try {
        writeJson(await fn(await getClient()));
      } catch (e) {
        writeError(e);
        process.exit(1);
      }
    };

  listOpt(s.command("tables").description("List dbo tables")).action(runList(runSchemaTables));
  listOpt(s.command("views").description("List dbo views")).action(runList(runSchemaViews));
  listOpt(s.command("procs").description("List dbo stored procedures and functions")).action(
    runList(runSchemaProcs)
  );

  s.command("table <name>").description("Columns, keys, FKs, and indexes for a table").action(
    runOne(runSchemaTable)
  );
  s.command("view <name>").description("Columns and definition (T-SQL) for a view").action(
    runOne(runSchemaView)
  );
  s.command("proc <name>")
    .description("Signature (parameters) and definition (T-SQL) for a proc/function")
    .action(runOne(runSchemaProc));

  s.command("dump")
    .description("Structural map of the whole schema (no proc/view bodies)")
    .action(runZero(runSchemaDump));
}
