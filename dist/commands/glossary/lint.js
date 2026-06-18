import { COMMAND_SPECS } from "../../reference/specs.js";
import { runGlossaryList } from "./index.js";
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
/** Pure validator. Returns all findings for the given entries. */
export function lintEntries(entries) {
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
    }
    // near-duplicate (pairwise Levenshtein 1)
    for (let i = 0; i < terms.length; i++)
        for (let j = i + 1; j < terms.length; j++)
            if (levenshtein(terms[i], terms[j]) === 1)
                findings.push({ term: terms[i], issue: "near-duplicate", detail: `'${terms[i]}' ~ '${terms[j]}' (distance 1 — possible mangle)`, severity: "warn" });
    return findings;
}
/** Fetch all glossary entries and return lint findings in a ListEnvelope. */
export async function runGlossaryLint(client) {
    const { items } = await runGlossaryList(client, {});
    const findings = lintEntries(items);
    return { items: findings, nextCursor: null, count: findings.length, truncated: false };
}
//# sourceMappingURL=lint.js.map