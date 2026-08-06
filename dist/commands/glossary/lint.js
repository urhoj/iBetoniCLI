import { listEnvelope } from "../../api/envelopes.js";
import { COMMAND_SPECS } from "../../reference/specs.js";
import { runGlossaryList } from "./index.js";
/** Needles shorter than this are dropped — too generic to match usefully (e.g. `pvm`, `m3`). */
const MIN_NEEDLE_LEN = 4;
/** Max candidate commands suggested per term, best-ranked first. */
const MAX_SUGGESTIONS_PER_TERM = 6;
/**
 * Every command path a `relatedCommands` entry may legitimately name: each
 * spec's own path plus every space-delimited GROUP prefix of it (`ib keikka
 * list` also admits `ib keikka` and `ib`). Built once per catalogue —
 * {@link isKnownCommandPath} otherwise re-scanned all ~311 specs per call, once
 * per relatedCommand of every entry.
 */
let knownPathCache;
function knownCommandPaths() {
    if (knownPathCache?.specs !== COMMAND_SPECS) {
        const paths = new Set();
        for (const s of COMMAND_SPECS) {
            paths.add(s.command);
            // `startsWith(p + " ")` can only be true for a prefix ending on a space
            // boundary, so the space-delimited prefixes are the complete set.
            for (let i = s.command.indexOf(" "); i > 0; i = s.command.indexOf(" ", i + 1)) {
                paths.add(s.command.slice(0, i));
            }
        }
        knownPathCache = { specs: COMMAND_SPECS, paths };
    }
    return knownPathCache.paths;
}
/** Returns true if `path` matches any known CommandSpec leaf OR is a group prefix of one. */
export function isKnownCommandPath(path) {
    const p = path.trim();
    if (!p)
        return false;
    return knownCommandPaths().has(p);
}
/**
 * True iff `levenshtein(a, b) === 1`, decided in O(len) with no allocation —
 * the full DP matrix was ~160 ms at 400 terms for an answer a single scan gives.
 * Only ever called on the candidate pairs from {@link nearDuplicateCandidates}.
 */
export function isEditDistance1(a, b) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1 || a === b)
        return false;
    if (la === lb) {
        // Exactly one substitution.
        let diffs = 0;
        for (let i = 0; i < la; i++)
            if (a[i] !== b[i] && ++diffs > 1)
                return false;
        return diffs === 1;
    }
    // Length differs by one: the longer must equal the shorter with one char skipped.
    const short = la < lb ? a : b;
    const long = la < lb ? b : a;
    let i = 0, j = 0, skipped = false;
    while (i < short.length) {
        if (short[i] === long[j]) {
            i++;
            j++;
            continue;
        }
        if (skipped)
            return false;
        skipped = true;
        j++;
    }
    return true;
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
    if (regexes.some((r) => r.test(spec.path)))
        return 3;
    if (regexes.some((r) => r.test(spec.flags)))
        return 2;
    if (regexes.some((r) => r.test(spec.rest)))
        return 1;
    return 0;
}
function buildHaystacks(specs) {
    return specs.map((s) => ({
        command: s.command,
        path: s.command.toLowerCase(),
        flags: (s.flags ?? []).map((f) => `${f.name} ${f.description ?? ""}`).join(" ").toLowerCase(),
        rest: `${s.description} ${(s.notes ?? []).join(" ")}`.toLowerCase(),
    }));
}
/**
 * Suggest candidate `relatedCommands` for one entry (fb#110): command specs
 * whose path/flags/description mention the term, a synonym, or the related
 * entity (whole-word, hyphen-aware) but that are NOT already linked. Returns
 * the best-ranked command paths, capped. Pure — `specs` is injectable for tests.
 */
export function suggestRelatedForEntry(e, specs = COMMAND_SPECS, haystacks = buildHaystacks(specs)) {
    const needles = [...new Set([e.term, ...(e.synonyms ?? []), e.relatedEntity ?? ""]
            .map((n) => (n ?? "").trim().toLowerCase())
            .filter((n) => n.length >= MIN_NEEDLE_LEN))];
    if (needles.length === 0)
        return [];
    const regexes = needles.map((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, "i"));
    const existing = (e.relatedCommands ?? []).map(cmdOf);
    return haystacks
        .map((s) => ({ command: s.command, score: scoreSpec(s, regexes) }))
        .filter((c) => c.score > 0 && !isCovered(c.command, existing))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SUGGESTIONS_PER_TERM)
        .map((c) => c.command);
}
/**
 * Index pairs `[i, j]` (i < j, ascending) worth an edit-distance check, as a
 * SUPERSET of the true near-duplicates: two terms at distance 1 always share a
 * "delete one character" key — equal length, delete the substituted position
 * from both; length differing by one, the shorter term IS a deletion variant of
 * the longer (hence each term is also keyed by itself). Bucketing on those keys
 * costs O(Σ|term|) where the all-pairs scan was O(n²) — 80k pairs at 400 terms.
 * Returned in the same (i, j) order the all-pairs scan visited, so the caller's
 * findings list is byte-identical.
 */
export function nearDuplicateCandidates(terms) {
    const buckets = new Map();
    const add = (key, i) => {
        const bucket = buckets.get(key);
        // Terms are keyed in index order, so a repeat of `i` is always the last entry.
        if (!bucket)
            buckets.set(key, [i]);
        else if (bucket[bucket.length - 1] !== i)
            bucket.push(i);
    };
    for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        add(t, i);
        for (let k = 0; k < t.length; k++)
            add(t.slice(0, k) + t.slice(k + 1), i);
    }
    const seen = new Set();
    const pairs = [];
    for (const bucket of buckets.values()) {
        for (let x = 0; x < bucket.length; x++) {
            for (let y = x + 1; y < bucket.length; y++) {
                const key = `${bucket[x]}:${bucket[y]}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                pairs.push([bucket[x], bucket[y]]);
            }
        }
    }
    return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}
/** Pure validator. Returns all findings for the given entries. */
export function lintEntries(entries, opts = {}) {
    const findings = [];
    const terms = entries.map((e) => e.term);
    const termSet = new Set(terms);
    // Spec haystacks depend only on the catalogue — build once, not per entry.
    const haystacks = opts.suggestRelated ? buildHaystacks(COMMAND_SPECS) : undefined;
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
            if (termSet.has(syn) && syn !== e.term)
                findings.push({ term: e.term, issue: "synonym-collision", detail: `synonym '${syn}' is another entry's canonical term`, severity: "info" });
        // stale-related (opt-in): commands that mention the term but aren't linked yet
        if (opts.suggestRelated && haystacks)
            for (const cmd of suggestRelatedForEntry(e, COMMAND_SPECS, haystacks))
                findings.push({ term: e.term, issue: "stale-related", detail: `'${cmd}' looks related to '${e.term}' but is not in relatedCommands`, severity: "info" });
    }
    // near-duplicate (edit distance 1), over bucketed candidate pairs in (i, j) order
    for (const [i, j] of nearDuplicateCandidates(terms))
        if (isEditDistance1(terms[i], terms[j]))
            findings.push({ term: terms[i], issue: "near-duplicate", detail: `'${terms[i]}' ~ '${terms[j]}' (distance 1 — possible mangle)`, severity: "warn" });
    return findings;
}
/** Fetch all glossary entries and return lint findings in a ListEnvelope. */
export async function runGlossaryLint(client, opts = {}) {
    const { items } = await runGlossaryList(client, {});
    const findings = lintEntries(items, opts);
    return listEnvelope(findings, { truncated: false });
}
//# sourceMappingURL=lint.js.map