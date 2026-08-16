import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { writeJson } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { CliError } from "../../api/errors.js";
import { qs } from "../../api/query.js";
import { warnIfTruncated } from "../../api/listCaps.js";
import { cappedInt } from "../../targets.js";

export interface SchemaListFilter {
  search?: string;
  limit?: number;
}

/** `triggers` adds a parent-table filter on top of the shared list filter. */
export interface SchemaTriggerFilter extends SchemaListFilter {
  table?: string;
}

type Envelope = ListEnvelope<Record<string, unknown>>;
type Record_ = Record<string, unknown>;

function listQuery(path: string, opts: SchemaListFilter): string {
  return `${path}${qs({ search: opts.search || undefined, limit: opts.limit })}`;
}

/**
 * Every schema list read goes through here so the cap can only ever be
 * announced in ONE place (fb#641).
 *
 * These commands are the CLI's answer to "introspect the live schema instead of
 * guessing", so a silently short page is not a missing convenience — it is a
 * confidently wrong answer to the question the command exists for. The backend
 * already flags it (fb#606); this is the half that puts it where a caller who
 * reads only `items` still sees it.
 *
 * Deliberately NOT hoisted into `writeJson` for every list in the CLI: some
 * commands set `truncated` for a non-cap reason (`glossary list --stalest` marks
 * a deliberate top-N slice), so a global warning would cry wolf on results that
 * are exactly what was asked for.
 */
async function getSchemaList(
  client: ApiClient,
  path: string,
  command: string
): Promise<Envelope> {
  const env = await client.get<Envelope>(path);
  warnIfTruncated(env, command);
  return env;
}

export async function runSchemaTables(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return getSchemaList(client, listQuery("/api/cli/schema/tables", opts), "ib dev schema tables");
}
export async function runSchemaViews(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return getSchemaList(client, listQuery("/api/cli/schema/views", opts), "ib dev schema views");
}
export async function runSchemaProcs(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return getSchemaList(client, listQuery("/api/cli/schema/procs", opts), "ib dev schema procs");
}
export async function runSchemaTriggers(
  client: ApiClient,
  opts: SchemaTriggerFilter
): Promise<Envelope> {
  return getSchemaList(
    client,
    `/api/cli/schema/triggers${qs({
      table: opts.table || undefined,
      search: opts.search || undefined,
      limit: opts.limit,
    })}`,
    "ib dev schema triggers"
  );
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
export async function runSchemaTrigger(client: ApiClient, name: string): Promise<Record_> {
  return client.get<Record_>(`/api/cli/schema/trigger/${name}`);
}
export async function runSchemaDump(client: ApiClient): Promise<Record_> {
  return client.get<Record_>("/api/cli/schema/dump");
}
/**
 * Migration snapshot tables + their retention state (fb#440). No `search` —
 * the server decides what counts as a snapshot (stamped, or matching the name
 * heuristic), and a substring filter on top would only hide rows from the very
 * report whose job is to be complete.
 */
export async function runSchemaSnapshots(client: ApiClient, opts: SchemaListFilter): Promise<Envelope> {
  return getSchemaList(
    client,
    `/api/cli/schema/snapshots${qs({ limit: opts.limit })}`,
    "ib dev schema snapshots"
  );
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
      .option("--search <substr>")
      .option("--limit <n>", "", cappedInt(1000));

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
  listOpt(s.command("triggers"))
    .option("--table <name>", "Only triggers whose parent table is <name>")
    .action(jsonAction(getClient, runSchemaTriggers));

  s.command("table <name>")
    .action(runOneOrBatch(runSchemaTable));
  s.command("view <name>")
    .action(runOneOrBatch(runSchemaView));
  s.command("proc <name>")
    .action(runOneOrBatch(runSchemaProc));
  s.command("trigger <name>")
    .action(runOneOrBatch(runSchemaTrigger));

  s.command("dump")
    .action(jsonAction(getClient, runSchemaDump));

  s.command("snapshots")
    .option("--limit <n>", "", cappedInt(1000))
    .action(jsonAction(getClient, runSchemaSnapshots));
}
