/**
 * `ib glossary lint` — read-only audit of glossary entries.
 * Pure logic lives here (unit-testable without a client); the Commander
 * action in index.ts calls runGlossaryLint(client).
 */
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import type { CommandSpec } from "../../output/help.js";
import { COMMAND_SPECS } from "../../reference/specs.js";
import { runGlossaryList } from "./index.js";

export interface LintFinding {
  term: string;
  issue: "dead-related" | "near-duplicate" | "empty-definition" | "no-anchor" | "synonym-collision" | "stale-related";
  detail: string;
  severity: "warn" | "info";
}

export interface LintOptions {
  /** When true, emit `stale-related` suggestions (candidate relatedCommands). Off by default (fb#110). */
  suggestRelated?: boolean;
}

/** Needles shorter than this are dropped — too generic to match usefully (e.g. `pvm`, `m3`). */
const MIN_NEEDLE_LEN = 4;
/** Max candidate commands suggested per term, best-ranked first. */
const MAX_SUGGESTIONS_PER_TERM = 6;

/** Returns true if `path` matches any known CommandSpec leaf OR is a group prefix of one. */
export function isKnownCommandPath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  return COMMAND_SPECS.some((s) => s.command === p || s.command.startsWith(p + " "));
}

/**
 * True iff `levenshtein(a, b) === 1`, decided in O(len) with no allocation —
 * the near-duplicate pass compares every term pair (O(n²) pairs), where the
 * full DP matrix was ~160 ms at 400 terms for an answer a single scan gives.
 */
export function isEditDistance1(a: string, b: string): boolean {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1 || a === b) return false;
  if (la === lb) {
    // Exactly one substitution.
    let diffs = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++diffs > 1) return false;
    return diffs === 1;
  }
  // Length differs by one: the longer must equal the shorter with one char skipped.
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < short.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

type RawEntry = {
  term: string;
  synonyms?: string[];
  definition?: string | null;
  relatedCommands?: Array<string | { command: string }>;
  relatedEntity?: string | null;
};

/** Extract the command path from a relatedCommands entry (string or object). */
const cmdOf = (c: string | { command: string }): string =>
  typeof c === "string" ? c : c.command;

/** Escape a string for use as a literal inside a RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True if a candidate command path is already covered by an existing linked
 * path — the same leaf, a leaf under an already-linked group, or a group that
 * already covers the linked leaf. Prevents suggesting `ib keikka list` when
 * the term already links the `ib keikka` group.
 */
function isCovered(candidate: string, existing: string[]): boolean {
  return existing.some(
    (p) => candidate === p || candidate.startsWith(p + " ") || p.startsWith(candidate + " ")
  );
}

/**
 * Rank a spec against a term's needle regexes: a match in the command PATH is
 * the strongest signal (3), then a FLAG name/description (2), then the
 * description/notes text (1); 0 = no match. Higher-ranked candidates win the
 * per-term cap so the best suggestions survive.
 */
function scoreSpec(spec: SpecHaystack, regexes: RegExp[]): number {
  if (regexes.some((r) => r.test(spec.path))) return 3;
  if (regexes.some((r) => r.test(spec.flags))) return 2;
  if (regexes.some((r) => r.test(spec.rest))) return 1;
  return 0;
}

/** A spec's lowercased search haystacks, built once per lint run — `scoreSpec`
 * otherwise rebuilt these per (entry × spec): ~124k redundant joins at 400 terms. */
interface SpecHaystack {
  command: string;
  path: string;
  flags: string;
  rest: string;
}

function buildHaystacks(specs: CommandSpec[]): SpecHaystack[] {
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
export function suggestRelatedForEntry(
  e: RawEntry,
  specs: CommandSpec[] = COMMAND_SPECS,
  haystacks: SpecHaystack[] = buildHaystacks(specs)
): string[] {
  const needles = [...new Set(
    [e.term, ...(e.synonyms ?? []), e.relatedEntity ?? ""]
      .map((n) => (n ?? "").trim().toLowerCase())
      .filter((n) => n.length >= MIN_NEEDLE_LEN)
  )];
  if (needles.length === 0) return [];
  const regexes = needles.map((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, "i"));
  const existing = (e.relatedCommands ?? []).map(cmdOf);
  return haystacks
    .map((s) => ({ command: s.command, score: scoreSpec(s, regexes) }))
    .filter((c) => c.score > 0 && !isCovered(c.command, existing))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS_PER_TERM)
    .map((c) => c.command);
}

/** Pure validator. Returns all findings for the given entries. */
export function lintEntries(entries: RawEntry[], opts: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const terms = entries.map((e) => e.term);
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
      if (terms.includes(syn) && syn !== e.term)
        findings.push({ term: e.term, issue: "synonym-collision", detail: `synonym '${syn}' is another entry's canonical term`, severity: "info" });

    // stale-related (opt-in): commands that mention the term but aren't linked yet
    if (opts.suggestRelated && haystacks)
      for (const cmd of suggestRelatedForEntry(e, COMMAND_SPECS, haystacks))
        findings.push({ term: e.term, issue: "stale-related", detail: `'${cmd}' looks related to '${e.term}' but is not in relatedCommands`, severity: "info" });
  }

  // near-duplicate (pairwise edit distance 1)
  for (let i = 0; i < terms.length; i++)
    for (let j = i + 1; j < terms.length; j++)
      if (isEditDistance1(terms[i], terms[j]))
        findings.push({ term: terms[i], issue: "near-duplicate", detail: `'${terms[i]}' ~ '${terms[j]}' (distance 1 — possible mangle)`, severity: "warn" });

  return findings;
}

/** Fetch all glossary entries and return lint findings in a ListEnvelope. */
export async function runGlossaryLint(client: ApiClient, opts: LintOptions = {}): Promise<ListEnvelope<LintFinding>> {
  const { items } = await runGlossaryList(client, {});
  const findings = lintEntries(items as unknown as RawEntry[], opts);
  return { items: findings, nextCursor: null, count: findings.length, truncated: false };
}
