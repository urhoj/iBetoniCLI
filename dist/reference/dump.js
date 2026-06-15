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
import { DOMAIN_OVERVIEW, FEEDBACK_GUIDANCE, TOPICS, glossaryForTier, } from "./domain.js";
import { visibleSpecs } from "../tier.js";
import { emitStdout } from "../output/json.js";
import packageJson from "../../package.json" with { type: "json" };
/**
 * Build the reference object. Pure — no I/O — so tests can assert on it
 * directly. Commands are keyed by their full path (e.g. `ib keikka list`),
 * matching what an AI assistant sees from `--help`. When `domain` is given,
 * the commands map is narrowed to that group (the token after `ib`) while the
 * primer (overview/glossary/topics/feedbackGuidance) is kept in full — it is
 * small, high-value context that keeps a filtered dump self-contained.
 * Unknown domain → exit-4 CliError (via assertKnownDomain).
 */
export function buildReference(domain, tier = "developer") {
    let specs = visibleSpecs(COMMAND_SPECS, tier);
    if (domain) {
        assertKnownDomain(COMMAND_SPECS, domain);
        specs = specs.filter((s) => s.command.split(" ")[1] === domain);
    }
    return {
        version: packageJson.version,
        generatedAt: new Date().toISOString(),
        overview: DOMAIN_OVERVIEW,
        glossary: glossaryForTier(tier),
        feedbackGuidance: FEEDBACK_GUIDANCE,
        topics: TOPICS,
        commands: Object.fromEntries(specs.map((spec) => [spec.command, spec])),
    };
}
/**
 * Write the reference dump as SINGLE-LINE JSON to stdout (the CLI's stdout
 * contract: one machine-parseable line). Used by the `ib reference dump`
 * subcommand (optionally narrowed to one `domain`). Pretty-printing was
 * dropped 2026-06-10: it was ~30% of the dump's bytes (pure indentation) and
 * pushed the customer domain over the 10k-token audit threshold.
 */
export function runReferenceDump(domain, tier = "developer") {
    emitStdout(JSON.stringify(buildReference(domain, tier)) + "\n");
}
//# sourceMappingURL=dump.js.map