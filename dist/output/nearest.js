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
 * verb → the canonical sibling(s) to try, in order.
 */
const VERB_SYNONYMS = {
    add: ["create"],
    create: ["add"],
    show: ["get"],
    view: ["get"],
};
/**
 * Closest name to `target` within an edit-distance threshold, else null.
 * A prefix match (`acc`→`accept`, target ≥ 2 chars) always wins; then the
 * minimum edit distance, accepted only when ≤ max(2, floor(len/2)); finally a
 * known verb-synonym (`add`→`create`, `show`→`get`) present among `names`.
 */
export function closestName(target, names) {
    if (!target || names.length === 0)
        return null;
    const t = target.toLowerCase();
    const prefix = names.find((n) => t.length >= 2 && n.toLowerCase().startsWith(t));
    if (prefix)
        return prefix;
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
    // Edit distance missed — fall back to a known verb synonym present in `names`.
    for (const syn of VERB_SYNONYMS[t] ?? []) {
        const hit = names.find((n) => n.toLowerCase() === syn);
        if (hit)
            return hit;
    }
    return null;
}
//# sourceMappingURL=nearest.js.map