import { listEnvelope } from "../../api/envelopes.js";
import { writeJson } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { CliError } from "../../api/errors.js";
import { qs } from "../../api/query.js";
import { warnIfTruncated } from "../../api/listCaps.js";
import { cappedInt } from "../../targets.js";
/**
 * One query-string builder for all five list leaves. `table` is only ever set by
 * `triggers`; `qs` drops undefined, so the other four render unchanged. Key order
 * is part of the asserted URL contract — keep it table, search, limit.
 */
function listQuery(path, opts) {
    return `${path}${qs({
        table: opts.table || undefined,
        search: opts.search || undefined,
        limit: opts.limit,
    })}`;
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
async function getSchemaList(client, path, command) {
    const env = await client.get(path);
    warnIfTruncated(env, command);
    return env;
}
export async function runSchemaTables(client, opts) {
    return getSchemaList(client, listQuery("/api/cli/schema/tables", opts), "ib dev schema tables");
}
export async function runSchemaViews(client, opts) {
    return getSchemaList(client, listQuery("/api/cli/schema/views", opts), "ib dev schema views");
}
export async function runSchemaProcs(client, opts) {
    return getSchemaList(client, listQuery("/api/cli/schema/procs", opts), "ib dev schema procs");
}
export async function runSchemaTriggers(client, opts) {
    return getSchemaList(client, listQuery("/api/cli/schema/triggers", opts), "ib dev schema triggers");
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
export async function runSchemaTrigger(client, name) {
    return client.get(`/api/cli/schema/trigger/${name}`);
}
export async function runSchemaRows(client, table, opts) {
    return getSchemaList(client, listQuery(`/api/cli/schema/rows/${table}`, opts), `ib dev schema rows ${table}`);
}
/**
 * Per-index usage statistics (sys.dm_db_index_usage_stats) — the live
 * counterpart of the monthly-generated indexes-performance.md doc. The
 * envelope's extra `statsSince` key is the moment every counter last reset
 * (SQL Server start time); zero reads mean nothing without it.
 */
export async function runSchemaIndexes(client, opts) {
    const path = `/api/cli/schema/indexes${qs({
        table: opts.table || undefined,
        search: opts.search || undefined,
        limit: opts.limit,
        unused: opts.unused ? 1 : undefined,
    })}`;
    return getSchemaList(client, path, "ib dev schema indexes");
}
export async function runSchemaDump(client) {
    return client.get("/api/cli/schema/dump");
}
/**
 * Ad-hoc read-only SQL (fb#438). POST because query text does not belong in a
 * URL, `{ read: true }` because it is still a READ — exempt from `--read-only`
 * and the acting-as write banner. The server enforces read-only twice: a text
 * guard (single SELECT/WITH statement, no semicolons, no INTO) and a
 * db_datareader-only login. Results are hard-capped at 1000 rows with
 * `truncated: true` when the cap bit — warn like every other capped list, so
 * a caller reading only `rows` cannot mistake a cut result for a complete one.
 */
export async function runSchemaQuery(client, sql) {
    const result = await client.post("/api/cli/schema/query", { sql }, { read: true });
    if (result.truncated) {
        // Tailored hint: this route has no --limit/--offset — the way past the cap
        // is a narrower WHERE or an aggregate (which is what this command is for).
        warnIfTruncated({
            truncated: true,
            count: result.rowCount,
            hint: `results are hard-capped at ${result.cap} rows — narrow with WHERE, or aggregate (COUNT/GROUP BY) instead of selecting raw rows`,
        }, "ib dev schema query");
    }
    return result;
}
/**
 * Migration snapshot tables + their retention state (fb#440). No `search` —
 * the server decides what counts as a snapshot (stamped, or matching the name
 * heuristic), and a substring filter on top would only hide rows from the very
 * report whose job is to be complete.
 */
export async function runSchemaSnapshots(client, opts) {
    return getSchemaList(client, `/api/cli/schema/snapshots${qs({ limit: opts.limit })}`, "ib dev schema snapshots");
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
    return listEnvelope(items);
}
/**
 * Register `ib schema` subcommands. Read-only resource (no write-safety flags).
 * Requires developer access server-side (isSystemAdmin or isDeveloper) — a
 * non-developer gets 403 → exit code 3.
 */
export function registerSchemaCommands(parent, getClient, opts = {}) {
    const s = parent.command("schema", { hidden: !!opts.hidden }).description("SQL schema introspection (developer-only)");
    const listOpt = (cmd) => cmd
        .option("--search <substr>")
        .option("--limit <n>", "", cappedInt(1000));
    // Single object by default; a comma in <name> switches to batch mode
    // (`ib dev schema proc a,b,c`) — parallel fan-out, deduped, 404-tolerant.
    const runOneOrBatch = (fn) => guarded(async (name) => {
        const client = await getClient();
        if (name.includes(",")) {
            const names = [...new Set(name.split(",").map((n) => n.trim()).filter(Boolean))];
            writeJson(await runSchemaBatch(client, fn, names));
        }
        else {
            writeJson(await fn(client, name));
        }
    });
    listOpt(s.command("tables")).action(jsonAction(getClient, runSchemaTables));
    listOpt(s.command("views")).action(jsonAction(getClient, runSchemaViews));
    listOpt(s.command("procs")).action(jsonAction(getClient, runSchemaProcs));
    listOpt(s.command("triggers"))
        .option("--table <name>", "Only triggers whose parent table is <name>")
        .action(jsonAction(getClient, runSchemaTriggers));
    listOpt(s.command("indexes"))
        .option("--table <name>", "Only indexes on this table (exact name)")
        .option("--unused", "Only indexes with zero reads (seeks+scans+lookups) since statsSince")
        .action(jsonAction(getClient, runSchemaIndexes));
    listOpt(s.command("rows <table>"))
        .description("Sample rows from a reference lookup table (allowlisted, developer-only)")
        .action(jsonAction(getClient, runSchemaRows));
    s.command("table <name>")
        .action(runOneOrBatch(runSchemaTable));
    s.command("view <name>")
        .action(runOneOrBatch(runSchemaView));
    s.command("proc <name>")
        .action(runOneOrBatch(runSchemaProc));
    s.command("trigger <name>")
        .action(runOneOrBatch(runSchemaTrigger));
    s.command("query")
        .description("Run one read-only SELECT (or WITH … SELECT) against the live DB — for data-SHAPE questions (COUNT, GROUP BY, histograms). Single statement, no semicolons, hard 1000-row cap; runs under a db_datareader-only login.")
        .requiredOption("--sql <select>", "The SELECT statement to run")
        .action(jsonAction(getClient, (client, opts) => runSchemaQuery(client, opts.sql)));
    s.command("dump")
        .action(jsonAction(getClient, runSchemaDump));
    s.command("snapshots")
        .option("--limit <n>", "", cappedInt(1000))
        .action(jsonAction(getClient, runSchemaSnapshots));
}
//# sourceMappingURL=index.js.map