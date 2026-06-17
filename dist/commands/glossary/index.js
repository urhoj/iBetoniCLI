import { writeJson, exitWithError } from "../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
const splitList = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
export async function runGlossaryLookup(client, term) {
    return client.get(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
}
export async function runGlossaryList(client, opts) {
    const q = new URLSearchParams();
    if (opts.search)
        q.set("search", opts.search);
    if (opts.stalest)
        q.set("stalest", String(opts.stalest));
    const qs = q.toString();
    const res = await client.get(`/api/cli/glossary${qs ? `?${qs}` : ""}`);
    return { items: res.items, nextCursor: null, count: res.count, truncated: opts.stalest != null };
}
export async function runGlossarySet(client, term, opts, flags = {}) {
    return client.put(`/api/cli/glossary/${encodeURIComponent(term)}`, {
        definition: opts.definition,
        synonyms: splitList(opts.synonyms),
        relatedCommands: splitList(opts.related),
        relatedEntity: opts.entity ?? null,
    }, { headers: writeFlagsToHeaders(flags) });
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
    glossary
        .command("lookup")
        .description("Resolve a term or synonym to its definition + related commands (exit 5 if undefined; the miss is recorded)")
        .argument("<term>", "A word or synonym, e.g. pumppari")
        .action(async (term) => {
        try {
            writeJson(await runGlossaryLookup(await getClient(), term));
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
    const set = glossary
        .command("set")
        .description("Create/update a glossary entry (developer only)")
        .argument("<term>", "Canonical term")
        .option("--definition <d>", "One-paragraph definition")
        .option("--synonyms <list>", "Comma-separated aliases incl. inflections")
        .option("--related <list>", 'Comma-separated command paths, e.g. "ib person,ib driver board"')
        .option("--entity <e>", "Related DB entity, e.g. Person / personId");
    addWriteFlagsToCommand(set).action(async (term, opts) => {
        try {
            writeJson(await runGlossarySet(await getClient(), term, { definition: opts.definition, synonyms: opts.synonyms, related: opts.related, entity: opts.entity }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
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