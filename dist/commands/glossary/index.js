/**
 * `ib glossary` — the DB-backed domain glossary (synonym-aware vocabulary).
 * lookup/list are open; set/delete/misses are developer-only. Backend:
 * /api/cli/glossary/*. The vocabulary is the single source of truth in the DB
 * (not bundled in betonicli) and is groomed via `ib glossary set`.
 */
import { readFileSync } from "node:fs";
import { writeJson, exitWithError, failWith, errorMessage } from "../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { CliError } from "../../api/errors.js";
import { runGlossaryLint } from "./lint.js";
const splitList = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const arrToCsv = (v) => Array.isArray(v) ? v.join(",") : (typeof v === "string" ? v : undefined);
export function mergeSetInput(json, flags) {
    return {
        definition: flags.definition ?? json.definition,
        synonyms: flags.synonyms ?? arrToCsv(json.synonyms),
        related: flags.related ?? arrToCsv(json.relatedCommands ?? json.related),
        entity: flags.entity ?? (json.relatedEntity ?? json.entity),
        domain: flags.domain ?? json.domain,
    };
}
export function readJsonInput(path) {
    const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
    return JSON.parse(raw);
}
export async function runGlossaryImport(client, entries, flags) {
    const results = [];
    for (const e of entries) {
        const term = e.term ?? null;
        if (!term) {
            results.push({ term: null, ok: false, error: "missing term" });
            continue;
        }
        const inp = mergeSetInput(e, {});
        try {
            await runGlossarySet(client, term, { definition: inp.definition, synonyms: inp.synonyms, related: inp.related, entity: inp.entity, domain: inp.domain, updateOnly: flags.updateOnly }, { dryRun: flags.dryRun, idempotencyKey: flags.idempotencyKey, reason: flags.reason });
            results.push({ term, ok: true });
        }
        catch (err) {
            results.push({ term, ok: false, error: errorMessage(err) });
        }
    }
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
export async function runGlossaryLookup(client, term) {
    try {
        return await client.get(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
    }
    catch (e) {
        if (e instanceof CliError && e.exitCode === 5) {
            // Enrich the miss with did-you-mean suggestions from the search endpoint.
            let hint = "";
            try {
                const prefix = term.length > 5 ? term.slice(0, 5) : term;
                const [full, partial] = await Promise.all([
                    client.get(`/api/cli/glossary?search=${encodeURIComponent(term)}`).catch(() => ({ items: [] })),
                    term.length > 5
                        ? client.get(`/api/cli/glossary?search=${encodeURIComponent(prefix)}`).catch(() => ({ items: [] }))
                        : Promise.resolve({ items: [] }),
                ]);
                const seen = new Set();
                const suggestions = [];
                for (const item of [
                    ...full.items,
                    ...partial.items,
                ]) {
                    if (!seen.has(item.term)) {
                        seen.add(item.term);
                        suggestions.push(item.term);
                    }
                }
                if (suggestions.length > 0) {
                    hint = ` Did you mean: ${suggestions.slice(0, 5).join(", ")}?`;
                }
            }
            catch { /* ignore suggestion errors */ }
            throw new CliError(`no glossary entry for '${term}'.${hint} (it has been recorded for definition)`, e.statusCode, e.body, 5);
        }
        throw e;
    }
}
export async function runGlossaryLookupBatch(client, terms) {
    const items = await Promise.all(terms.map(async (term) => {
        try {
            const entry = await client.get(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
            return { term, found: true, entry };
        }
        catch (e) {
            if (e instanceof CliError && e.statusCode === 404)
                return { term, found: false, entry: null };
            throw e;
        }
    }));
    return { items, nextCursor: null, count: items.length };
}
export async function runGlossaryList(client, opts) {
    const q = new URLSearchParams();
    if (opts.search)
        q.set("search", opts.search);
    if (opts.stalest)
        q.set("stalest", String(opts.stalest));
    if (opts.domain)
        q.set("domain", opts.domain);
    if (opts.related)
        q.set("related", opts.related);
    const qs = q.toString();
    const res = await client.get(`/api/cli/glossary${qs ? `?${qs}` : ""}`);
    return { items: res.items, nextCursor: null, count: res.count, truncated: opts.stalest != null };
}
export async function runGlossarySet(client, term, opts, flags = {}) {
    const headers = { ...writeFlagsToHeaders(flags), ...(opts.updateOnly ? { "X-Update-Only": "1" } : {}) };
    return client.put(`/api/cli/glossary/${encodeURIComponent(term)}`, {
        definition: opts.definition,
        synonyms: splitList(opts.synonyms),
        relatedCommands: splitList(opts.related),
        relatedEntity: opts.entity ?? null,
        domain: opts.domain ?? null,
    }, { headers });
}
export async function runGlossaryMisses(client, top) {
    const res = await client.get(`/api/cli/glossary/misses${top ? `?top=${top}` : ""}`);
    return { items: res.items, nextCursor: null, count: res.count, truncated: top != null };
}
export async function runGlossaryDelete(client, term, flags = {}) {
    return client.delete(`/api/cli/glossary/${encodeURIComponent(term)}`, { headers: writeFlagsToHeaders(flags) });
}
export function registerGlossaryCommands(program, getClient) {
    const glossary = program.command("glossary").description("Domain glossary: resolve a Finnish/colloquial term to its meaning + commands (DB-backed)");
    // Change A: mark lookup as the default subcommand so `ib glossary <term>`
    // routes here without spelling out "lookup". The term is optional so bare
    // `ib glossary` (no arg) shows a friendly usage message instead of erroring.
    glossary
        .command("lookup [term]", { isDefault: true })
        .description("Resolve a term or synonym to its definition + related commands (exit 5 if undefined; the miss is recorded)")
        .action(async (term) => {
        if (!term) {
            // Bare `ib glossary` with no subcommand and no term — show group help.
            glossary.outputHelp();
            return;
        }
        try {
            if (term.includes(",")) {
                const terms = [...new Set(term.split(",").map((t) => t.trim()).filter(Boolean))];
                writeJson(await runGlossaryLookupBatch(await getClient(), terms));
            }
            else {
                writeJson(await runGlossaryLookup(await getClient(), term));
            }
        }
        catch (e) {
            exitWithError(e);
        }
    });
    glossary
        .command("list")
        .description("List glossary entries; --search filters, --stalest orders least-recently-reviewed first")
        .option("--search <s>", "Filter by term/definition/synonym substring")
        .option("--stalest <n>", "Return up to N entries, stalest first", (v) => Number(v))
        .option("--domain <d>", "Filter to a domain (exact match)")
        .option("--related <substr>", "Filter to terms whose relatedCommands contain this substring")
        .action(async (opts) => {
        try {
            writeJson(await runGlossaryList(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    glossary
        .command("misses")
        .description("Open lookup misses ranked by frequency — the groomer's queue (developer only)")
        .option("--top <n>", "Return up to N", (v) => Number(v))
        .action(async (opts) => {
        try {
            writeJson(await runGlossaryMisses(await getClient(), opts.top));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    glossary
        .command("lint")
        .description("Audit entries: dead relatedCommands, near-duplicate terms, empty fields (developer only)")
        .option("--strict", "Exit 1 if any warn-level finding exists (for CI)")
        .action(async (opts) => {
        try {
            const res = await runGlossaryLint(await getClient());
            writeJson(res);
            if (opts.strict && res.items.some((f) => f.severity === "warn"))
                process.exitCode = 1;
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const set = glossary
        .command("set")
        .description("Create/update a glossary entry (developer only)")
        .argument("<term>", "Canonical term")
        .option("--definition <d>", "One-paragraph definition")
        .option("--synonyms <list>", "Comma-separated aliases incl. inflections")
        .option("--related <list>", 'Comma-separated command paths, e.g. "ib person,ib driver board"')
        .option("--entity <e>", "Related DB entity, e.g. Person / personId")
        .option("--domain <d>", "Domain grouping (e.g. vacation)")
        .option("--update-only", "Only update an existing term; do not create a new one (404 if absent)")
        .option("--from-json <file>", "Read fields from a JSON object file (or - for stdin); explicit flags override");
    addWriteFlagsToCommand(set).action(async (term, opts) => {
        let merged = { definition: opts.definition, synonyms: opts.synonyms, related: opts.related, entity: opts.entity, domain: opts.domain };
        if (opts.fromJson) {
            let json;
            try {
                json = readJsonInput(opts.fromJson);
            }
            catch {
                failWith("--from-json: not valid JSON", 4);
            }
            merged = mergeSetInput(json, { definition: opts.definition, synonyms: opts.synonyms, related: opts.related, entity: opts.entity, domain: opts.domain });
        }
        try {
            writeJson(await runGlossarySet(await getClient(), term, { definition: merged.definition, synonyms: merged.synonyms, related: merged.related, entity: merged.entity, domain: merged.domain, updateOnly: opts.updateOnly }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const imp = glossary
        .command("import")
        .description("Bulk create/update entries from a JSON array file (developer only). Avoids shell argv mangling of Finnish ä/ö.")
        .argument("<file>", "JSON array file of {term, definition, synonyms?, related?, entity?} (or - for stdin)");
    addWriteFlagsToCommand(imp)
        .option("--update-only", "Only update existing terms; never insert")
        .action(async (file, opts) => {
        let arr;
        try {
            arr = readJsonInput(file);
        }
        catch {
            failWith("import: file is not valid JSON", 4);
        }
        if (!Array.isArray(arr)) {
            failWith("import: JSON root must be an array", 4);
        }
        try {
            writeJson(await runGlossaryImport(await getClient(), arr, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason, updateOnly: opts.updateOnly }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const del = glossary
        .command("delete")
        .description("Delete a glossary entry (developer only)")
        .argument("<term>", "Canonical term");
    addWriteFlagsToCommand(del).action(async (term, opts) => {
        try {
            writeJson(await runGlossaryDelete(await getClient(), term, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map