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
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
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
 */
export const VERB_SYNONYMS: Record<string, string[]> = {
  add: ["create"],
  create: ["add"],
  show: ["get"],
  view: ["get"],
  changes: ["log"],
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
export const FLAG_SYNONYMS: Record<string, string[]> = {
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
};

/**
 * Closest name to `target` within an edit-distance threshold, else null.
 * A prefix match (`acc`→`accept`, target ≥ 2 chars) always wins; then the
 * minimum edit distance, accepted only when ≤ max(2, floor(len/2)); finally a
 * known synonym present among `names`.
 *
 * `synonyms` selects the table: {@link VERB_SYNONYMS} for subcommand names (the
 * default, so enum values via `assertEnum` keep their existing behaviour) and
 * {@link FLAG_SYNONYMS} for option names. They are kept apart deliberately —
 * `type`→`kind` is right for a flag and meaningless for a verb.
 */
export function closestName(
  target: string,
  names: string[],
  synonyms: Record<string, string[]> = VERB_SYNONYMS
): string | null {
  if (!target || names.length === 0) return null;
  const t = target.toLowerCase();
  const prefix = names.find((n) => t.length >= 2 && n.toLowerCase().startsWith(t));
  if (prefix) return prefix;
  const threshold = Math.max(2, Math.floor(t.length / 2));
  let best: string | null = null;
  let bestDist = Infinity;
  for (const n of names) {
    const d = levenshtein(t, n.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  if (best !== null && bestDist <= threshold) return best;
  // Edit distance missed — fall back to a known synonym present in `names`.
  for (const syn of synonyms[t] ?? []) {
    const hit = names.find((n) => n.toLowerCase() === syn);
    if (hit) return hit;
  }
  return null;
}
