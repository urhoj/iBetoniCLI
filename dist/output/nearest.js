/**
 * Fuzzy "did you mean" matching — the one implementation behind every
 * near-miss hint the CLI emits: unknown subcommands (`unknownCommand.ts`) and
 * unknown enum-flag values (`targets.ts` `assertEnum`).
 *
 * A LEAF module by design: it imports nothing. Its two consumers sit on
 * opposite sides of a real import cycle — `unknownCommand.ts` needs
 * `reference/specs.ts`, whose enum sets come from the command modules, which
 * import `targets.ts`. Homing the matcher in `unknownCommand.ts` and importing
 * it from `targets.ts` closes that loop and leaves `KINDS` undefined at
 * spec-evaluation time (feedback #369).
 */
/** Classic Levenshtein edit distance (two-row). */
export function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}
/**
 * Verb synonyms an AI naturally reaches for but that edit distance can't bridge
 * (feedback #229): the `add` (changelog) vs `create` (every other group) split,
 * and `show`/`view` for the canonical `get`. Consulted only after prefix + edit
 * distance both miss, so a real near-match always wins. Keyed by the mistyped
 * verb or group name → the canonical sibling(s) to try, in order.
 *
 * `changes`→`log` is the RETIRED-NAME case (fb#402): the changeTracker group was
 * renamed `ib changes`→`ib log` as a clean break (2026-06-11, betonicli
 * 87482f8), so the old name is not merely unregistered — it is deliberately
 * gone, and `changes` sits 6 edits from `log` with no shared prefix, i.e. exactly
 * the guess no derived layer can reach. Docs written before the rename keep
 * teaching it, so the miss recurs long after the break.
 *
 * `stats`↔`count` is the SAME-CONCEPT-TWO-SPELLINGS case (fb#611), and it is
 * bidirectional because both spellings are live in the catalogue: `count` on
 * `ib dev feedback`, `stats` on `ib dev perf` / `ib jerry admin request`. So
 * whichever one a caller has just used, the other is wrong somewhere — exactly
 * the condition {@link FLAG_SYNONYMS} documents for its bidirectional pairs.
 * Edit distance cannot bridge them (5 apart, no shared prefix). `ib dev
 * feedback stats` ALSO resolves as a real hidden alias on the command itself,
 * so that particular miss now succeeds outright; this entry covers the rest of
 * the catalogue and any group added later.
 */
export const VERB_SYNONYMS = {
    add: ["create"],
    create: ["add"],
    show: ["get"],
    view: ["get"],
    changes: ["log"],
    stats: ["count"],
    count: ["stats"],
};
/**
 * FLAG synonyms — the option analogue of {@link VERB_SYNONYMS} (feedback #388).
 *
 * Edit distance cannot bridge `--query`→`--search` (distance 5 against a
 * threshold of 2), so a semantically obvious guess returned `didYouMean: null`
 * and cost a failed call. Same guard rails as the verb table: consulted only
 * after prefix + edit distance both miss, and it can only ever resolve to a name
 * that is ALREADY in `names` — so a command owning a real `--text` / `--type`
 * flag is never overridden, and the table cannot invent a flag.
 *
 * Pairs are bidirectional wherever BOTH spellings are live in the catalogue
 * (`asiakas` 38 uses ↔ `customer` 9, `worksite` 13 ↔ `tyomaa` 3, `type` 20 ↔
 * `kind` 4). That is the case this exists for: the majority spelling is right on
 * most commands and wrong on the minority that use the other, so guessing either
 * one is wrong somewhere. One-way entries point at a spelling with no live
 * counterpart (`pvm`→`date`: the Finnish form appears in the domain vocabulary
 * but no spec declares it).
 */
export const FLAG_SYNONYMS = {
    query: ["search"],
    q: ["search"],
    term: ["search"],
    keyword: ["search"],
    filter: ["search"],
    text: ["search"],
    customer: ["asiakas"],
    client: ["asiakas"],
    asiakas: ["customer"],
    worksite: ["tyomaa"],
    tyomaa: ["worksite"],
    site: ["worksite"],
    pvm: ["date"],
    type: ["kind"],
    kind: ["type"],
    // Cross-command synonym family (fb#870): the textEdit trio owns bare
    // --append, while `feedback update` spells it --append-description and
    // `glossary set` --append-definition. An agent moving between them reaches
    // for bare --append; the table resolves it only on commands that own one of
    // the prefixed forms — the trio's real --append is never overridden.
    append: ["append-description", "append-definition"],
};
/**
 * Closest name to `target` within an edit-distance threshold, else null.
 * A prefix match (`acc`→`accept`, target ≥ 2 chars) always wins; then an
 * ends-with match, then any substring/contains match (fb#832 — a short token
 * like `id` should resolve to `feedbackId`, which contains it, before edit
 * distance ranks a closer-but-unrelated name); then the minimum edit distance,
 * accepted only when ≤ max(2, floor(len/2)); finally a known synonym present
 * among `names`.
 *
 * `synonyms` selects the table: {@link VERB_SYNONYMS} for subcommand names (the
 * default, so enum values via `assertEnum` keep their existing behaviour) and
 * {@link FLAG_SYNONYMS} for option names. They are kept apart deliberately —
 * `type`→`kind` is right for a flag and meaningless for a verb.
 */
export function closestName(target, names, synonyms = VERB_SYNONYMS) {
    if (!target || names.length === 0)
        return null;
    const t = target.toLowerCase();
    const prefix = names.find((n) => t.length >= 2 && n.toLowerCase().startsWith(t));
    if (prefix)
        return prefix;
    // Substring/ends-with pass (fb#832): for short tokens like "id", edit distance
    // ranks "kind" (distance 2) above "feedbackId" (distance 8) — but "feedbackId"
    // literally contains the typed token. Prefer a column that ENDS WITH the token
    // (the most natural match for identifier shorthand), then any column that
    // CONTAINS it, before falling through to edit distance.
    if (t.length >= 2) {
        const endsWith = names.find((n) => n.toLowerCase().endsWith(t));
        if (endsWith)
            return endsWith;
        const contains = names.find((n) => n.toLowerCase().includes(t));
        if (contains)
            return contains;
    }
    const threshold = Math.max(2, Math.floor(t.length / 2));
    let best = null;
    let bestDist = Infinity;
    for (const n of names) {
        const d = levenshtein(t, n.toLowerCase());
        if (d < bestDist) {
            bestDist = d;
            best = n;
        }
    }
    if (best !== null && bestDist <= threshold)
        return best;
    // Edit distance missed — fall back to a known synonym present in `names`.
    for (const syn of synonyms[t] ?? []) {
        const hit = names.find((n) => n.toLowerCase() === syn);
        if (hit)
            return hit;
    }
    return null;
}
//# sourceMappingURL=nearest.js.map