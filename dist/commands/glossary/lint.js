import { COMMAND_SPECS } from "../../reference/specs.js";
import { runGlossaryList } from "./index.js";
/** Needles shorter than this are dropped — too generic to match usefully (e.g. `pvm`, `m3`). */
const MIN_NEEDLE_LEN = 4;
/** Max candidate commands suggested per term, best-ranked first. */
const MAX_SUGGESTIONS_PER_TERM = 6;
/** Returns true if `path` matches any known CommandSpec leaf OR is a group prefix of one. */
export function isKnownCommandPath(path) {
    const p = path.trim();
    if (!p)
        return false;
    return COMMAND_SPECS.some((s) => s.command === p || s.command.startsWith(p + " "));
}
/** Levenshtein edit distance between two strings. */
export function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++)
        d[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
}
/** Extract the command path from a relatedCommands entry (string or object). */
const cmdOf = (c) => typeof c === "string" ? c : c.command;
/** Escape a string for use as a literal inside a RegExp. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * True if a candidate command path is already covered by an existing linked
 * path — the same leaf, a leaf under an already-linked group, or a group that
 * already covers the linked leaf. Prevents suggesting `ib keikka list` when
 * the term already links the `ib keikka` group.
 */
function isCovered(candidate, existing) {
    return existing.some((p) => candidate === p || candidate.startsWith(p + " ") || p.startsWith(candidate + " "));
}
/**
 * Rank a spec against a term's needle regexes: a match in the command PATH is
 * the strongest signal (3), then a FLAG name/description (2), then the
 * description/notes text (1); 0 = no match. Higher-ranked candidates win the
 * per-term cap so the best suggestions survive.
 */
function scoreSpec(spec, regexes) {
    const path = spec.command.toLowerCase();
    if (regexes.some((r) => r.test(path)))
        return 3;
    const flags = (spec.flags ?? []).map((f) => `${f.name} ${f.description ?? ""}`).join(" ").toLowerCase();
    if (regexes.some((r) => r.test(flags)))
        return 2;
    const rest = `${spec.description} ${(spec.notes ?? []).join(" ")}`.toLowerCase();
    if (regexes.some((r) => r.test(rest)))
        return 1;
    return 0;
}
/**
 * Suggest candidate `relatedCommands` for one entry (fb#110): command specs
 * whose path/flags/description mention the term, a synonym, or the related
 * entity (whole-word, hyphen-aware) but that are NOT already linked. Returns
 * the best-ranked command paths, capped. Pure — `specs` is injectable for tests.
 */
export function suggestRelatedForEntry(e, specs = COMMAND_SPECS) {
    const needles = [...new Set([e.term, ...(e.synonyms ?? []), e.relatedEntity ?? ""]
            .map((n) => (n ?? "").trim().toLowerCase())
            .filter((n) => n.length >= MIN_NEEDLE_LEN))];
    if (needles.length === 0)
        return [];
    const regexes = needles.map((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, "i"));
    const existing = (e.relatedCommands ?? []).map(cmdOf);
    return specs
        .map((s) => ({ command: s.command, score: scoreSpec(s, regexes) }))
        .filter((c) => c.score > 0 && !isCovered(c.command, existing))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SUGGESTIONS_PER_TERM)
        .map((c) => c.command);
}
/** Pure validator. Returns all findings for the given entries. */
export function lintEntries(entries, opts = {}) {
    const findings = [];
    const terms = entries.map((e) => e.term);
    for (const e of entries) {
        // empty-definition
        if (!e.definition || !e.definition.trim())
            findings.push({ term: e.term, issue: "empty-definition", detail: "definition is empty", severity: "warn" });
        // dead-related
        for (const rc of e.relatedCommands ?? []) {
            const cmd = cmdOf(rc);
            if (!isKnownCommandPath(cmd))
                findings.push({ term: e.term, issue: "dead-related", detail: `relatedCommand '${cmd}' matches no spec`, severity: "warn" });
        }
        // no-anchor
        if ((e.relatedCommands ?? []).length === 0 && !(e.relatedEntity ?? "").trim())
            findings.push({ term: e.term, issue: "no-anchor", detail: "no relatedCommands and no relatedEntity", severity: "info" });
        // synonym-collision
        for (const syn of e.synonyms ?? [])
            if (terms.includes(syn) && syn !== e.term)
                findings.push({ term: e.term, issue: "synonym-collision", detail: `synonym '${syn}' is another entry's canonical term`, severity: "info" });
        // stale-related (opt-in): commands that mention the term but aren't linked yet
        if (opts.suggestRelated)
            for (const cmd of suggestRelatedForEntry(e))
                findings.push({ term: e.term, issue: "stale-related", detail: `'${cmd}' looks related to '${e.term}' but is not in relatedCommands`, severity: "info" });
    }
    // near-duplicate (pairwise Levenshtein 1)
    for (let i = 0; i < terms.length; i++)
        for (let j = i + 1; j < terms.length; j++)
            if (levenshtein(terms[i], terms[j]) === 1)
                findings.push({ term: terms[i], issue: "near-duplicate", detail: `'${terms[i]}' ~ '${terms[j]}' (distance 1 — possible mangle)`, severity: "warn" });
    return findings;
}
/** Fetch all glossary entries and return lint findings in a ListEnvelope. */
export async function runGlossaryLint(client, opts = {}) {
    const { items } = await runGlossaryList(client, {});
    const findings = lintEntries(items, opts);
    return { items: findings, nextCursor: null, count: findings.length, truncated: false };
}
//# sourceMappingURL=lint.js.map