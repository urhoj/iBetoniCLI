import { failWith } from "./output/json.js";
import { intFlag } from "./targets.js";
/**
 * Validate a self-assessed confidence: an integer 0–100, or undefined (the flag
 * was omitted — a human edit that resets the score). `failWith` throws a CliError
 * mapped to exit 4.
 */
export function assertAiConfidence(v) {
    if (v === undefined)
        return;
    if (!Number.isInteger(v) || v < 0 || v > 100) {
        failWith("--ai-confidence must be an integer 0–100", 4);
    }
}
/**
 * Attach the AI self-assessment WRITE flags to a mutation command. Descriptions
 * are intentionally blank: `attachRichHelp` fully replaces `--help` rendering for
 * every spec'd command with the spec's own flag descriptions (`assessWriteFlags`
 * in reference/specs/shared.ts), so these strings render nowhere and only rot
 * (fb#952 already found them drifted once; a code-simplifier pass over fb#958
 * found them drifted again).
 */
export function addAssessWriteFlags(cmd) {
    return cmd
        .option("--ai-confidence <n>", "", 
    // Bare Number is safe here: assertAiConfidence re-validates the 0–100
    // range on every write path.
    (v) => Number(v))
        .option("--needs-human-review")
        .option("--no-needs-human-review");
}
/**
 * Attach the AI groom SELECT flags to a list command. Descriptions are
 * intentionally blank — see {@link addAssessWriteFlags}'s comment; the spec
 * twin is `needsReviewFlags` in reference/specs/shared.ts.
 */
export function addNeedsReviewFlags(cmd) {
    return cmd
        .option("--needs-review")
        .option("--max-confidence <n>", "", intFlag("--max-confidence", 0));
}
//# sourceMappingURL=assess.js.map