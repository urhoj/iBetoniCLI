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
import { DOMAIN_OVERVIEW, GLOSSARY, FEEDBACK_GUIDANCE, TOPICS } from "./domain.js";
import type { GlossaryEntry, Topic } from "./domain.js";
import type { CommandSpec } from "../output/help.js";
import packageJson from "../../package.json" with { type: "json" };

export interface ReferenceDump {
  version: string;
  generatedAt: string;
  /** Plain-language description of the platform, tenancy model, BetoniJerry. */
  overview: string;
  /** Core entities + recurring Finnish field names. */
  glossary: GlossaryEntry[];
  /** When an AI consuming this CLI should proactively file `ib feedback`. */
  feedbackGuidance: typeof FEEDBACK_GUIDANCE;
  /** Offline concept guides for cross-cutting knowledge (`ib help <id>`). */
  topics: Topic[];
  commands: Record<string, CommandSpec>;
}

/**
 * Build the reference object. Pure — no I/O — so tests can assert on it
 * directly. Commands are keyed by their full path (e.g. `ib keikka list`),
 * matching what an AI assistant sees from `--help`. When `domain` is given,
 * the commands map is narrowed to that group (the token after `ib`) while the
 * primer (overview/glossary/topics/feedbackGuidance) is kept in full — it is
 * small, high-value context that keeps a filtered dump self-contained.
 * Unknown domain → exit-4 CliError (via assertKnownDomain).
 */
export function buildReference(domain?: string): ReferenceDump {
  let specs = COMMAND_SPECS;
  if (domain) {
    assertKnownDomain(COMMAND_SPECS, domain);
    specs = COMMAND_SPECS.filter((s) => s.command.split(" ")[1] === domain);
  }
  return {
    version: packageJson.version,
    generatedAt: new Date().toISOString(),
    overview: DOMAIN_OVERVIEW,
    glossary: GLOSSARY,
    feedbackGuidance: FEEDBACK_GUIDANCE,
    topics: TOPICS,
    commands: Object.fromEntries(specs.map((spec) => [spec.command, spec])),
  };
}

/**
 * Write the reference dump as pretty-printed JSON to stdout. Used by the
 * `ib reference dump` subcommand (optionally narrowed to one `domain`).
 * Trailing newline so shells / `jq` see a clean line-terminated document.
 */
export function runReferenceDump(domain?: string): void {
  process.stdout.write(JSON.stringify(buildReference(domain), null, 2) + "\n");
}
