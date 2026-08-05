import { writeJson, failWith, errorMessage } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { listEnvelope } from "../../api/envelopes.js";
import { CliError } from "../../api/errors.js";
import { readJsonInput } from "../../api/parseBody.js";
import { runGlossaryLint } from "./lint.js";
import { assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "../../assess.js";
import { qs } from "../../api/query.js";
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
 *
 * The two ASSESSMENT fields are the exception to that last sentence, and the
 * reason they must be merged here (fb#298): the backend does NOT COALESCE them,
 * it direct-assigns (`aiConfidence == null ? null : …`, `needsHumanReview ? 1 : 0`
 * in glossaryCliRoutes.js) so that omitting them RESETS the row and re-opens it
 * for grooming. Dropping a JSON-supplied aiConfidence therefore does not merely
 * fail to write it — it silently wipes the stored score. That bit `import`
 * hardest: it has no --ai-confidence flag at all, so a bulk groom could only
 * ever carry the score per-entry in the JSON.
 */
export function mergeSetInput(json, flags) {
    return {
        definition: flags.definition ?? json.definition,
        synonyms: flags.synonyms ?? arrToCsv(json.synonyms),
        related: flags.related ?? arrToCsv(json.relatedCommands ?? json.related),
        entity: flags.entity ?? (json.relatedEntity ?? json.entity),
        domain: flags.domain ?? json.domain,
        aiConfidence: flags.aiConfidence ?? json.aiConfidence,
        needsHumanReview: flags.needsHumanReview ?? json.needsHumanReview,
    };
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
            await runGlossarySet(client, term, { definition: inp.definition, synonyms: inp.synonyms, related: inp.related, entity: inp.entity, domain: inp.domain,
                aiConfidence: inp.aiConfidence, needsHumanReview: inp.needsHumanReview, updateOnly: flags.updateOnly }, flags);
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
    return listEnvelope(items);
}
export async function runGlossaryList(client, opts) {
    const res = await client.get(`/api/cli/glossary${qs({
        search: opts.search || undefined,
        stalest: opts.stalest || undefined,
        domain: opts.domain || undefined,
        related: opts.related || undefined,
        needsReview: opts.needsReview ? "1" : undefined,
        maxConfidence: opts.needsReview && opts.maxConfidence != null ? opts.maxConfidence : undefined,
    })}`);
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
 * Dismiss an open glossary miss (junk/test lookup terms) WITHOUT defining it.
 * `--dry-run` is SERVER-SIDE (X-Dry-Run): safe here because the guard ships in
 * the same deploy as the route — an older backend 404s the two-segment path
 * instead of persisting. A dismissed term re-enters the queue if looked up again.
 */
export async function runGlossaryDismiss(client, term, flags = {}) {
    if (!term.trim())
        failWith("dismiss: term must be non-empty", 4);
    return client.delete(`/api/cli/glossary/misses/${encodeURIComponent(term)}`, { headers: writeFlagsToHeaders(flags) });
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
        .action(guarded(async (term) => {
        if (!term) {
            // Bare `ib glossary` with no subcommand and no term — show group help.
            glossary.outputHelp();
            return;
        }
        if (term.includes(",")) {
            const terms = [...new Set(term.split(",").map((t) => t.trim()).filter(Boolean))];
            writeJson(await runGlossaryLookupBatch(await getClient(), terms));
        }
        else {
            writeJson(await runGlossaryLookup(await getClient(), term));
        }
    }));
    addNeedsReviewFlags(glossary
        .command("list")
        .option("--search <s>", "Filter by term/definition/synonym substring")
        .option("--stalest <n>", "Return up to N entries, stalest first", (v) => Number(v))
        .option("--domain <d>", "Filter to a domain (exact match)")
        .option("--related <substr>", "Filter to terms whose relatedCommands contain this substring")
        .option("--terms-only", "Return only {term, synonyms} per entry (cheap index view; strips definitions)")).action(jsonAction(getClient, (client, opts) => runGlossaryList(client, opts)));
    glossary
        .command("misses")
        .option("--top <n>", "Return up to N", (v) => Number(v))
        .action(jsonAction(getClient, (client, opts) => runGlossaryMisses(client, opts.top)));
    const dismiss = glossary
        .command("dismiss")
        .argument("<term>", "Missed term to dismiss (as listed by `ib glossary misses`)");
    addWriteFlagsToCommand(dismiss).action(jsonAction(getClient, (client, term, opts) => runGlossaryDismiss(client, term, opts)));
    glossary
        .command("lint")
        .option("--strict", "Exit 1 if any warn-level finding exists (for CI)")
        .option("--suggest-related", "Also suggest candidate relatedCommands: specs mentioning a term/synonym/entity but not yet linked (info-level, fb#110)")
        .action(guarded(async (opts) => {
        const res = await runGlossaryLint(await getClient(), { suggestRelated: opts.suggestRelated });
        writeJson(res);
        if (opts.strict && res.items.some((f) => f.severity === "warn"))
            process.exitCode = 1;
    }));
    const set = glossary
        .command("set")
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
    addWriteFlagsToCommand(addAssessWriteFlags(set)).action(guarded(async (term, opts) => {
        const flagFields = {
            definition: opts.definition, synonyms: opts.synonyms, related: opts.related, entity: opts.entity, domain: opts.domain,
            aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview,
        };
        let merged = flagFields;
        if (opts.fromJson) {
            let json;
            try {
                json = readJsonInput(opts.fromJson);
            }
            catch {
                failWith("--from-json: not valid JSON", 4);
            }
            merged = mergeSetInput(json, flagFields);
        }
        // Validate the MERGED score, not just the flag — a --from-json object can
        // now supply aiConfidence, and an out-of-range value there deserves the
        // same client-side exit 4 as a bad flag (fb#298).
        assertAiConfidence(merged.aiConfidence);
        writeJson(await runGlossarySet(await getClient(), term, { definition: merged.definition, synonyms: merged.synonyms, related: merged.related, entity: merged.entity, domain: merged.domain,
            addSynonyms: opts.addSynonyms, removeSynonyms: opts.removeSynonyms, appendDefinition: opts.appendDefinition,
            updateOnly: opts.updateOnly, aiConfidence: merged.aiConfidence, needsHumanReview: merged.needsHumanReview }, opts));
    }));
    const imp = glossary
        .command("import")
        .description("Bulk create/update entries from a JSON array file (developer only). Avoids shell argv mangling of Finnish ä/ö.")
        .argument("<file>", "JSON array file of {term, definition, synonyms?, related?, entity?} (or - for stdin)");
    addWriteFlagsToCommand(imp)
        .option("--update-only", "Only update existing terms; never insert")
        .action(guarded(async (file, opts) => {
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
        writeJson(await runGlossaryImport(await getClient(), arr, opts));
    }));
    const del = glossary
        .command("delete")
        .argument("<term>", "Canonical term");
    addWriteFlagsToCommand(del).action(jsonAction(getClient, (client, term, opts) => runGlossaryDelete(client, term, opts)));
}
//# sourceMappingURL=index.js.map