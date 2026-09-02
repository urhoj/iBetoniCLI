/**
 * Flag-vocabulary guards (feedback #388).
 *
 * #388 was not one bad flag, it was a CLASS: a flag spelled one way on a single
 * command and another way on the 38 others, so an AI guessing the majority form
 * failed on the outlier and guessing the outlier form failed everywhere else.
 * Renaming the two known instances fixes today; these two tests are the detector
 * that keeps the class from coming back.
 */
import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { FLAG_SYNONYMS, VERB_SYNONYMS } from "../../src/output/nearest.js";

/** flag name → the commands whose spec declares it. */
const flagOwners = (): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const spec of COMMAND_SPECS) {
    for (const f of spec.flags ?? []) {
      const list = out.get(f.name) ?? [];
      list.push(spec.command);
      out.set(f.name, list);
    }
  }
  return out;
};

/** Final token of every command path — the catalogue's verb vocabulary. */
const verbNames = (): Set<string> =>
  new Set(COMMAND_SPECS.map((s) => s.command.split(" ").pop() as string));

describe("synonym tables cannot rot", () => {
  // The tables only ever resolve to a name already present in the candidate
  // list, so a dead entry is silent — it just never fires. Same failure mode as
  // a dead `relatedCommands` path in the glossary, and the same remedy: assert
  // the target still exists in the live catalogue.
  test("every FLAG_SYNONYMS target is a real flag somewhere in the catalogue", () => {
    const owners = flagOwners();
    const dead: string[] = [];
    for (const [from, targets] of Object.entries(FLAG_SYNONYMS)) {
      for (const to of targets) {
        if (!owners.has(to)) dead.push(`--${from} → --${to}`);
      }
    }
    expect(dead).toEqual([]);
  });

  test("every VERB_SYNONYMS target is a real verb somewhere in the catalogue", () => {
    const verbs = verbNames();
    const dead: string[] = [];
    for (const [from, targets] of Object.entries(VERB_SYNONYMS)) {
      for (const to of targets) {
        if (!verbs.has(to)) dead.push(`${from} → ${to}`);
      }
    }
    expect(dead).toEqual([]);
  });

  test("no synonym maps a name to itself (a no-op entry that hides a real gap)", () => {
    const selfMapped = [
      ...Object.entries(FLAG_SYNONYMS),
      ...Object.entries(VERB_SYNONYMS),
    ].filter(([from, targets]) => targets.includes(from));
    expect(selfMapped).toEqual([]);
  });
});

describe("no new naming outliers", () => {
  /** A flag on this many commands or more is the established house spelling. */
  const COMMON_THRESHOLD = 5;

  /**
   * Singleton flags that merely LOOK like a near-spelling of a common one but
   * are genuinely different parameters — checked by hand, listed so a real
   * outlier cannot hide among them.
   *
   * `--today` vs `--to` (a date bound vs a keyword), `--address2` vs
   * `--address` (postal line 2), `--all-companies` / `--allow-big-merge` vs
   * `--all`, `--from-brand` vs `--from` (sender identity vs date bound),
   * `--sijainti-types` vs `--sijainti` (a type filter vs an id). (`--top` sat
   * here until fb#1138 renamed it to the house `--limit`.)
   */
  const ALLOWED_NEAR_SPELLINGS = new Set([
    "today",
    "address2",
    "all-companies",
    "allow-big-merge",
    "from-brand",
    "sijainti-types",
  ]);

  /**
   * Every singleton flag sharing a STEM with an established one, allowlist NOT
   * applied — returns `name → the common flag it shadows`.
   *
   * A shared stem only (`--asiakas-id` vs `--asiakas`: one spelling is the other
   * plus a qualifier). Deliberately NOT edit distance: among short flag names
   * that fires on genuinely unrelated pairs (`--out`/`--lat`, `--by`/`--to`,
   * `--in`/`--to` — 20 false positives when tried), and a guard that noisy gets
   * rubber-stamped rather than read. Runtime typos are `closestName`'s job; this
   * is about catalogue CONSISTENCY.
   */
  const nearSpellings = (): Map<string, string> => {
    const owners = flagOwners();
    const common = [...owners.entries()]
      .filter(([, cmds]) => cmds.length >= COMMON_THRESHOLD)
      .map(([name]) => name);
    const bare = (s: string): string => s.replace(/-/g, "");
    const out = new Map<string, string>();
    for (const [name, cmds] of owners) {
      if (cmds.length !== 1) continue;
      const shadowed = common.find(
        (c) => c !== name && (bare(c).startsWith(bare(name)) || bare(name).startsWith(bare(c)))
      );
      if (shadowed) out.set(name, shadowed);
    }
    return out;
  };

  test("a one-off flag is not a near-spelling of an established one", () => {
    const owners = flagOwners();
    const suspects = [...nearSpellings()]
      .filter(([name]) => !ALLOWED_NEAR_SPELLINGS.has(name))
      .map(
        ([name, c]) =>
          `--${name} (only on ${owners.get(name)![0]}) vs --${c} (${owners.get(c)!.length} commands)`
      );
    expect(
      suspects,
      "rename to the majority spelling and keep the old form as a hidden alias (see fb#388), or add it to ALLOWED_NEAR_SPELLINGS with a reason"
    ).toEqual([]);
  });

  test("the rule is live — every allowlisted name is still matched by it", () => {
    // Without this, narrowing the rule until it matches nothing would leave the
    // suite green and the whole class undetected. Each allowlist entry is a
    // known instance of the shape, so all of them must still be found.
    const detected = nearSpellings();
    const missed = [...ALLOWED_NEAR_SPELLINGS].filter((n) => !detected.has(n));
    expect(
      missed,
      "the near-spelling rule no longer fires on known instances — it has been narrowed into a no-op, or these flags were renamed/removed (drop them from ALLOWED_NEAR_SPELLINGS)"
    ).toEqual([]);
  });

  test("no spec flag is a single character (unspellable, never guessable)", () => {
    // `--q` was the second #388 outlier: no fuzzy or semantic route reaches it
    // from `--search`, so the majority guess mis-routed to a different command.
    const owners = flagOwners();
    const tooShort = [...owners.keys()].filter((n) => n.length < 2);
    expect(tooShort).toEqual([]);
  });
});
