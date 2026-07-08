import { writeJson, exitWithError } from "../../output/json.js";
import { CliError } from "../../api/errors.js";
function listQuery(path, opts) {
    const params = new URLSearchParams();
    if (opts.search)
        params.set("search", opts.search);
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    return `${path}${qs ? `?${qs}` : ""}`;
}
export async function runSchemaTables(client, opts) {
    return client.get(listQuery("/api/cli/schema/tables", opts));
}
export async function runSchemaViews(client, opts) {
    return client.get(listQuery("/api/cli/schema/views", opts));
}
export async function runSchemaProcs(client, opts) {
    return client.get(listQuery("/api/cli/schema/procs", opts));
}
export async function runSchemaTable(client, name) {
    return client.get(`/api/cli/schema/table/${name}`);
}
export async function runSchemaView(client, name) {
    return client.get(`/api/cli/schema/view/${name}`);
}
export async function runSchemaProc(client, name) {
    return client.get(`/api/cli/schema/proc/${name}`);
}
export async function runSchemaDump(client) {
    return client.get("/api/cli/schema/dump");
}
/**
 * Batch the single-object lookups (`table`/`view`/`proc`) — the comma-separated
 * path (feedback #109). Fans out the SAME single-object `run*` function in
 * parallel so each name's path lives in exactly one place. Mirrors
 * `runGlossaryLookupBatch`: a 404 for one name is swallowed to
 * `{ found: false, object: null }` so the batch always resolves; any non-404
 * error still throws. Caller dedupes names before this is reached.
 */
export async function runSchemaBatch(client, single, names) {
    const items = await Promise.all(names.map(async (name) => {
        try {
            return { name, found: true, object: await single(client, name) };
        }
        catch (e) {
            if (e instanceof CliError && e.statusCode === 404)
                return { name, found: false, object: null };
            throw e;
        }
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * Register `ib schema` subcommands. Read-only resource (no write-safety flags).
 * Requires developer access server-side (isSystemAdmin or isDeveloper) — a
 * non-developer gets 403 → exit code 3.
 */
export function registerSchemaCommands(parent, getClient, opts = {}) {
    const s = parent.command("schema", { hidden: !!opts.hidden }).description("SQL schema introspection (developer-only)");
    const listOpt = (cmd) => cmd
        .option("--search <substr>", "Filter object names by substring")
        .option("--limit <n>", "Max rows (default 200, max 1000)", (v) => Math.min(Number(v), 1000));
    const runList = (fn) => async (opts) => {
        try {
            writeJson(await fn(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    };
    // Single object by default; a comma in <name> switches to batch mode
    // (`ib dev schema proc a,b,c`) — parallel fan-out, deduped, 404-tolerant.
    const runOneOrBatch = (fn) => async (name) => {
        try {
            const client = await getClient();
            if (name.includes(",")) {
                const names = [...new Set(name.split(",").map((n) => n.trim()).filter(Boolean))];
                writeJson(await runSchemaBatch(client, fn, names));
            }
            else {
                writeJson(await fn(client, name));
            }
        }
        catch (e) {
            exitWithError(e);
        }
    };
    const runZero = (fn) => async () => {
        try {
            writeJson(await fn(await getClient()));
        }
        catch (e) {
            exitWithError(e);
        }
    };
    listOpt(s.command("tables").description("List dbo tables")).action(runList(runSchemaTables));
    listOpt(s.command("views").description("List dbo views")).action(runList(runSchemaViews));
    listOpt(s.command("procs").description("List dbo stored procedures and functions")).action(runList(runSchemaProcs));
    s.command("table <name>")
        .description("Columns, keys, FKs, and indexes for a table (comma-separated names → batch)")
        .action(runOneOrBatch(runSchemaTable));
    s.command("view <name>")
        .description("Columns and definition (T-SQL) for a view (comma-separated names → batch)")
        .action(runOneOrBatch(runSchemaView));
    s.command("proc <name>")
        .description("Signature (parameters) and definition (T-SQL) for a proc/function (comma-separated names → batch)")
        .action(runOneOrBatch(runSchemaProc));
    s.command("dump")
        .description("Structural map of the whole schema (no proc/view bodies)")
        .action(runZero(runSchemaDump));
}
//# sourceMappingURL=index.js.map