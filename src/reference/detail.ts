/**
 * `ib reference detail <command…>` — return one command's on-demand business
 * context (`CommandSpec.detail`). The AI pulls this to verify a claim or get
 * domain context; it is intentionally NOT in `ib reference dump` or the catalog.
 * The command path is the tokens AFTER `ib` (e.g. `keikka latest`). Throws a
 * CliError mapped to exit 5 (not-found) when the command is unknown or has no
 * detail yet.
 */
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { feedbackHintFor } from "./feedbackHint.js";
import { type CallerTier, visibleSpecs } from "../tier.js";

export function runReferenceDetail(
  commandParts: string[],
  tier: CallerTier = "developer"
): {
  command: string;
  detail: string;
  hint: string;
} {
  const command = `ib ${commandParts.join(" ")}`.trim();
  // Resolve against the VISIBLE set only — a command hidden at the caller's
  // tier falls into the "unknown command" branch (fail-closed), so a standard
  // caller cannot read a developer-only command's detail.
  const spec = visibleSpecs(COMMAND_SPECS, tier).find((s) => s.command === command);
  if (!spec) {
    throw new CliError(
      `unknown command: ${command}. Use \`ib commands\` or \`ib reference dump\` for valid paths.`,
      0,
      null,
      5
    );
  }
  if (!spec.detail) {
    throw new CliError(
      `no detail recorded yet for ${command}. Try \`${command} --help\`, or it will be filled by an optimize-ib-summaries run.`,
      0,
      null,
      5
    );
  }
  return { command, detail: spec.detail, hint: feedbackHintFor(command) };
}
