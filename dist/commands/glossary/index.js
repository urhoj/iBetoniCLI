/**
 * `ib glossary` — the DB-backed domain glossary (synonym-aware vocabulary).
 * lookup/list are open; set/import/lint/delete/misses are developer-only. Backend:
 * /api/cli/glossary/*. The vocabulary is the single source of truth in the DB.
 * Key behaviors: lookup <term> → exit 5 + miss recorded on 404, did-you-mean
 * hints via /glossary?search=, comma-separated terms → batch lookup; set is a
 * PARTIAL update (omitted flags preserved via COALESCE; "" clears), --update-only
 * 404s instead of inserting, --from-json reads one object; import bulk-sets a
 * JSON array (avoids Finnish ä/ö shell mangling); lint audits dead
 * relatedCommands, near-duplicates, empty fields.
 */
import { readFileSync } from "node:fs";
import { writeJson, exitWithError, failWith, errorMessage } from "../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { CliError } from "../../api/errors.js";
import { runGlossaryLint } from "./lint.js";
import { assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "../../assess.js";
const splitList = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const arrToCsv = (v) => Array.isArray(v) ? v.join(",") : (typeof v === "string" ? v : undefined);
/**
 * Project glossary rows to the {term, synonyms} INDEX shape — strips definition
 * and developer-tier-leaking fields. Shared by `glossary list --terms-only` and
 * the primer/dump (re-exported from reference/dump.ts for existing consumers).
 */
export function projectGlossaryForPrimer(items) {
    return items.map((g) => ({
        term: g["term"],
        synonyms: (g["synonyms"] ?? []),
    }));
}
/**
 * Merge fields from a parsed JSON object with explicit CLI flags.
 * Flags take precedence over the JSON values — an explicitly-passed flag always
 * wins regardless of what the JSON file contains. Fields absent from both json
 * and flags are left `undefined` (omitted from the PATCH body, so the backend
 * COALESCE preserves the current DB value).
 */
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
    const raw = (path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(raw);
}
/**
 * Bulk-set entries from a pre-parsed JSON array. Runs sequentially (one PUT per
 * entry) so individual failures don't abort the batch — each result records
 * `ok: true/false` and, on failure, the `error` message. The summary counts are
 * returned; callers can check `failed > 0` to decide whether to exit non-zero.
 * Entries missing `term` are recorded as `{ term: null, ok: false }` without a
 * network round-trip.
 */
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
/**
 * Resolve a single term to its glossary entry. On a 404 (exit 5), the miss is
 * recorded server-side, then this function enriches the CliError with did-you-mean
 * hints by querying /glossary?search= (full term + 5-char prefix in parallel).
 * The enriched CliError is re-thrown — callers see exit 5 with the hint appended
 * to the message. Network errors during hint fetching are silently ignored.
 */
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
/**
 * Resolve multiple terms in parallel (the comma-separated lookup path). Unlike
 * `runGlossaryLookup`, a 404 for an individual term is swallowed and returned as
 * `{ term, found: false, entry: null }` so the batch always resolves — other
 * non-404 errors are re-thrown. Duplicate terms are deduplicated by the caller
 * before this function is reached (the Commander action uses a Set).
 */
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
    if (opts.needsReview)
        q.set("needsReview", "1");
    if (opts.needsReview && opts.maxConfidence != null)
        q.set("maxConfidence", String(opts.maxConfidence));
    const qs = q.toString();
    const res = await client.get(`/api/cli/glossary${qs ? `?${qs}` : ""}`);
    const items = opts.termsOnly
        ? projectGlossaryForPrimer(res.items)
        : res.items;
    return { items, nextCursor: null, count: res.count, truncated: opts.stalest != null };
}
export async function runGlossarySet(client, term, opts, flags = {}) {
    // Append flags edit in place; they cannot combine with their overwrite twin.
    if (opts.definition !== undefined && opts.appendDefinition !== undefined) {
        failWith("--definition and --append-definition are mutually exclusive", 4);
    }
    if (opts.synonyms !== undefined && (opts.addSynonyms !== undefined || opts.removeSynonyms !== undefined)) {
        failWith("--synonyms and --add-synonyms/--remove-synonyms are mutually exclusive", 4);
    }
    const headers = { ...writeFlagsToHeaders(flags), ...(opts.updateOnly ? { "X-Update-Only": "1" } : {}) };
    // PARTIAL update (PATCH): send ONLY the fields the caller actually passed. An
    // omitted flag is left out of the body entirely, so the backend preserves the
    // current value (COALESCE). An EMPTY value clears: `--synonyms ""` -> [] (clear),
    // `--entity ""` -> "" (clear). `--from-json` / `import` set every field present
    // in the object. NOTE: preservation needs the partial-aware backend deployed;
    // against an older backend an omitted field is still overwritten to empty/null.
    const body = {};
    if (opts.definition !== undefined)
        body.definition = opts.definition;
    if (opts.synonyms !== undefined)
        body.synonyms = splitList(opts.synonyms);
    if (opts.related !== undefined)
        body.relatedCommands = splitList(opts.related);
    if (opts.entity !== undefined)
        body.relatedEntity = opts.entity;
    if (opts.domain !== undefined)
        body.domain = opts.domain;
    if (opts.addSynonyms !== undefined)
        body.addSynonyms = splitList(opts.addSynonyms);
    if (opts.removeSynonyms !== undefined)
        body.removeSynonyms = splitList(opts.removeSynonyms);
    if (opts.appendDefinition !== undefined)
        body.appendDefinition = opts.appendDefinition;
    if (opts.aiConfidence !== undefined)
        body.aiConfidence = opts.aiConfidence;
    if (opts.needsHumanReview)
        body.needsHumanReview = true;
    return client.put(`/api/cli/glossary/${encodeURIComponent(term)}`, body, { headers });
}
export async function runGlossaryMisses(client, top) {
    const res = await client.get(`/api/cli/glossary/misses${top ? `?top=${top}` : ""}`);
    return { items: res.items, nextCursor: null, count: res.count, truncated: top != null };
}
/**
 * Delete a glossary entry. `--dry-run` resolves CLIENT-SIDE: it previews the
 * entry that WOULD be deleted and NEVER issues the DELETE. The backend DELETE
 * route historically ignored `X-Dry-Run` and destroyed the row regardless
 * (fb#76), so relying on a server-side dry-run here was a data-loss footgun.
 * The preview is fetched via the `?search=` list endpoint — which, unlike
 * `/lookup/:term`, does NOT record a glossary miss for an absent term — and
 * exact-matched on the normalized term (backend `normalizeTerm` = trim+lower).
 * A real run issues the DELETE with the write-safety headers.
 */
export async function runGlossaryDelete(client, term, flags = {}) {
    if (flags.dryRun) {
        let wouldDelete = null;
        try {
            const res = await client.get(`/api/cli/glossary?search=${encodeURIComponent(term)}`);
            const norm = term.trim().toLowerCase();
            wouldDelete = (res.items ?? []).find((e) => String(e.term).toLowerCase() === norm) ?? null;
        }
        catch {
            // Best-effort preview: a search failure must not turn a dry-run into an error.
        }
        return { dryRun: true, term, wouldDelete };
    }
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
    addNeedsReviewFlags(glossary
        .command("list")
        .description("List glossary entries; --search filters, --stalest orders least-recently-reviewed first")
        .option("--search <s>", "Filter by term/definition/synonym substring")
        .option("--stalest <n>", "Return up to N entries, stalest first", (v) => Number(v))
        .option("--domain <d>", "Filter to a domain (exact match)")
        .option("--related <substr>", "Filter to terms whose relatedCommands contain this substring")
        .option("--terms-only", "Return only {term, synonyms} per entry (cheap index view; strips definitions)")).action(async (opts) => {
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
        .description("Create/update a glossary entry — PARTIAL: only fields you pass change; omit to keep, \"\" to clear (developer only)")
        .argument("<term>", "Canonical term")
        .option("--definition <d>", "One-paragraph definition (omit to keep current)")
        .option("--synonyms <list>", 'Comma-separated aliases incl. inflections (omit to keep; "" to clear)')
        .option("--related <list>", 'Comma-separated command paths, e.g. "ib person,ib vehicle driver board" (omit to keep; "" to clear)')
        .option("--entity <e>", "Related DB entity, e.g. Person / personId (omit to keep)")
        .option("--domain <d>", "Domain grouping (e.g. vacation) (omit to keep)")
        .option("--update-only", "Only update an existing term; do not create a new one (404 if absent)")
        .option("--from-json <file>", "Read fields from a JSON object file (or - for stdin); explicit flags override")
        .option("--add-synonyms <list>", "Comma-separated synonyms to ADD (no full resend; excl. --synonyms)")
        .option("--remove-synonyms <list>", "Comma-separated synonyms to REMOVE by name (excl. --synonyms)")
        .option("--append-definition <text>", "Append a clause to the current definition (excl. --definition)");
    addWriteFlagsToCommand(addAssessWriteFlags(set)).action(async (term, opts) => {
        assertAiConfidence(opts.aiConfidence);
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
            writeJson(await runGlossarySet(await getClient(), term, { definition: merged.definition, synonyms: merged.synonyms, related: merged.related, entity: merged.entity, domain: merged.domain,
                addSynonyms: opts.addSynonyms, removeSynonyms: opts.removeSynonyms, appendDefinition: opts.appendDefinition,
                updateOnly: opts.updateOnly, aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
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