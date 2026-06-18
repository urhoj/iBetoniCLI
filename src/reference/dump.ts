/**
 * `ib reference dump` — emits the entire CLI command surface as a single JSON
 * document.
 *
 * The dump is what an AI assistant ingests once at session start to know every
 * command, flag, permission, output shape, error code, and example. The same
 * {@link CommandSpec} objects back the `--help` text rendered by
 * `src/output/help.ts`, so the JSON dump and the human help can never drift
 * out of sync — there is exactly one source of truth (`./specs.ts`).
 */
import { COMMAND_SPECS } from "./specs.js";
import { assertKnownDomain } from "./commandsList.js";
import {
  DOMAIN_OVERVIEW,
  FEEDBACK_GUIDANCE,
  TOPICS,
} from "./domain.js";
import type { Topic } from "./domain.js";
import type { CommandSpec } from "../output/help.js";
import { type CallerTier, visibleSpecs, isHiddenAtTier } from "../tier.js";
import { emitStdout } from "../output/json.js";
import packageJson from "../../package.json" with { type: "json" };
import type { ApiClient } from "../api/client.js";
import { runGlossaryList } from "../commands/glossary/index.js";

export interface ReferenceDump {
  version: string;
  generatedAt: string;
  /** Plain-language description of the platform, tenancy model, BetoniJerry. */
  overview: string;
  /**
   * Vocabulary INDEX — term + synonyms ONLY (DB-backed; [] when unavailable).
   * Definitions are intentionally omitted so the dump stays small as the glossary
   * grows (it ships in every full dump, root `--help`, and AI primer). Fetch a
   * definition on demand: `ib glossary lookup <term>` (one) / `ib glossary list` (all).
   */
  glossary: Array<{ term: string; synonyms: string[] }>;
  /** When an AI consuming this CLI should proactively file `ib feedback`. */
  feedbackGuidance: typeof FEEDBACK_GUIDANCE;
  /** Offline concept guides for cross-cutting knowledge (`ib help <id>`). */
  topics: Topic[];
  commands: Record<string, CommandSpec>;
}

/**
 * For a non-developer tier, strip cross-references (seeAlso / notes / examples)
 * that name a command hidden at that tier — otherwise the dump's prose teaches a
 * standard caller that the hidden subtrees exist (the dump filters WHICH specs
 * appear, but emits each visible spec's prose verbatim, and ~10 of those strings
 * cross-reference hidden command paths). Developer tier: spec returned unchanged
 * (byte-for-byte parity). `hiddenCommands` are full paths (e.g. `ib ai
 * conversation`), matched as substrings of the backtick-quoted mentions.
 * Only the prose arrays (`seeAlso`/`notes`/`examples`) are scrubbed; `description`
 * and `flags` don't embed backtick command paths in practice.
 */
function scrubSpecForTier(
  spec: CommandSpec,
  tier: CallerTier,
  hiddenCommands: string[]
): CommandSpec {
  if (tier === "developer") return spec;
  const mentionsHidden = (s: string): boolean =>
    hiddenCommands.some((h) => s.includes(h));
  const out: CommandSpec = { ...spec };
  if (spec.seeAlso) out.seeAlso = spec.seeAlso.filter((r) => !mentionsHidden(r));
  if (spec.notes) out.notes = spec.notes.filter((n) => !mentionsHidden(n));
  if (spec.examples) out.examples = spec.examples.filter((e) => !mentionsHidden(e));
  return out;
}

/**
 * Project a raw DB glossary item array to the vocabulary INDEX the dump/--help
 * primer documents: `{ term, synonyms }` only. The `definition` is deliberately
 * dropped here — it is the bulk of each entry's bytes and rides in every full
 * dump, the root `--help` GLOSSARY, and the AI primer, so as the glossary grows
 * it would bloat all three. The term+synonyms index is enough for an AI to map
 * any colloquial/Finnish word to a canonical term, then fetch the definition on
 * demand via `ib glossary lookup <term>` (or `ib glossary list` for all). Also
 * drops the other DB fields (`relatedCommands`, `relatedEntity`, `runs`,
 * `lastReviewed`, `domain`, …) so developer-tier data cannot leak through the
 * glossary of a standard-tier dump or root `--help`.
 *
 * Exported as a pure helper so it can be unit-tested independently of the
 * network layer.
 */
export function projectGlossaryForPrimer(
  items: Array<Record<string, unknown>>
): Array<{ term: string; synonyms: string[] }> {
  return items.map((g) => ({
    term: g["term"] as string,
    synonyms: (g["synonyms"] ?? []) as string[],
  }));
}

/**
 * Best-effort fetch of the DB glossary projected to the primer shape
 * ({term,synonyms,definition} only — strips developer-tier-leaking fields).
 * Returns [] on any failure (offline/tokenless/route-not-deployed). Shared by
 * the root `--help` prefetch (bin/ib.ts) and the `reference dump` action.
 */
export async function fetchPrimerGlossary(
  client: ApiClient
): Promise<Array<{ term: string; synonyms: string[] }>> {
  try {
    const res = await runGlossaryList(client, {});
    return projectGlossaryForPrimer(res.items as Array<Record<string, unknown>>);
  } catch {
    return [];
  }
}

/**
 * Build the reference object. Pure — no I/O — so tests can assert on it
 * directly. Commands are keyed by their full path (e.g. `ib keikka list`),
 * matching what an AI assistant sees from `--help`. When one or more `domain`s
 * are given, the commands map is narrowed to those groups (the token after
 * `ib`) while the primer (overview/glossary/topics/feedbackGuidance) is kept in
 * full — it is small, high-value context that keeps a filtered dump
 * self-contained, and emitted ONCE no matter how many domains are passed (so
 * `dump ai attachment` beats two single-domain dumps). Unknown domain → exit-4
 * CliError (via assertKnownDomain). At a non-developer tier each surviving
 * spec's prose is run through `scrubSpecForTier` so no cross-reference leaks a
 * hidden command path.
 */
export function buildReference(
  domain?: string | string[],
  tier: CallerTier = "developer",
  glossary: Array<{ term: string; synonyms: string[] }> = []
): ReferenceDump {
  let specs = visibleSpecs(COMMAND_SPECS, tier);
  const domains = domain == null ? [] : Array.isArray(domain) ? domain : [domain];
  if (domains.length) {
    for (const d of domains) assertKnownDomain(COMMAND_SPECS, d, tier);
    const wanted = new Set(domains);
    specs = specs.filter((s) => wanted.has(s.command.split(" ")[1]));
  }
  const hiddenCommands = COMMAND_SPECS.filter((s) => isHiddenAtTier(s, tier)).map(
    (s) => s.command
  );
  return {
    version: packageJson.version,
    generatedAt: new Date().toISOString(),
    overview: DOMAIN_OVERVIEW,
    glossary,
    feedbackGuidance: FEEDBACK_GUIDANCE,
    topics: TOPICS,
    commands: Object.fromEntries(
      specs.map((spec) => [spec.command, scrubSpecForTier(spec, tier, hiddenCommands)])
    ),
  };
}

/**
 * Write the reference dump as SINGLE-LINE JSON to stdout (the CLI's stdout
 * contract: one machine-parseable line). Used by the `ib reference dump`
 * subcommand (optionally narrowed to one or more `domain`s). Pretty-printing was
 * dropped 2026-06-10: it was ~30% of the dump's bytes (pure indentation) and
 * pushed the customer domain over the 10k-token audit threshold.
 *
 * `commandsOnly` strips the primer (overview/glossary/topics/feedbackGuidance)
 * and emits only `{ version, generatedAt, commands }` — the ~2-3 KB of static
 * discovery scaffolding is pure overhead for a caller (e.g. the
 * optimize-ib-summaries cron) that already knows the domain context and just
 * needs the command specs. The caller also skips the glossary DB fetch in that
 * mode (no token needed), so this is both fewer bytes and one fewer round-trip.
 */
export function runReferenceDump(
  domain?: string | string[],
  tier: CallerTier = "developer",
  glossary: Array<{ term: string; synonyms: string[] }> = [],
  commandsOnly = false
): void {
  const ref = buildReference(domain, tier, glossary);
  const out = commandsOnly
    ? { version: ref.version, generatedAt: ref.generatedAt, commands: ref.commands }
    : ref;
  emitStdout(JSON.stringify(out) + "\n");
}
