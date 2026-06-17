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

export interface ReferenceDump {
  version: string;
  generatedAt: string;
  /** Plain-language description of the platform, tenancy model, BetoniJerry. */
  overview: string;
  /** Core entities + recurring Finnish field names (DB-backed; [] when unavailable). */
  glossary: Array<{ term: string; synonyms: string[]; definition: string | null }>;
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
 * Build the reference object. Pure — no I/O — so tests can assert on it
 * directly. Commands are keyed by their full path (e.g. `ib keikka list`),
 * matching what an AI assistant sees from `--help`. When `domain` is given,
 * the commands map is narrowed to that group (the token after `ib`) while the
 * primer (overview/glossary/topics/feedbackGuidance) is kept in full — it is
 * small, high-value context that keeps a filtered dump self-contained.
 * Unknown domain → exit-4 CliError (via assertKnownDomain). At a non-developer
 * tier each surviving spec's prose is run through `scrubSpecForTier` so no
 * cross-reference leaks a hidden command path.
 */
export function buildReference(
  domain?: string,
  tier: CallerTier = "developer",
  glossary: Array<{ term: string; synonyms: string[]; definition: string | null }> = []
): ReferenceDump {
  let specs = visibleSpecs(COMMAND_SPECS, tier);
  if (domain) {
    assertKnownDomain(COMMAND_SPECS, domain, tier);
    specs = specs.filter((s) => s.command.split(" ")[1] === domain);
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
 * subcommand (optionally narrowed to one `domain`). Pretty-printing was
 * dropped 2026-06-10: it was ~30% of the dump's bytes (pure indentation) and
 * pushed the customer domain over the 10k-token audit threshold.
 */
export function runReferenceDump(
  domain?: string,
  tier: CallerTier = "developer",
  glossary: Array<{ term: string; synonyms: string[]; definition: string | null }> = []
): void {
  emitStdout(JSON.stringify(buildReference(domain, tier, glossary)) + "\n");
}
