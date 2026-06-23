import { failWith } from "./output/json.js";
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
/** Attach the AI self-assessment WRITE flags to a mutation command. */
export function addAssessWriteFlags(cmd) {
    return cmd
        .option("--ai-confidence <n>", "Self-assessed completeness/correctness of the content you just wrote (0–100; see the groom rubric). Omit on a human edit to reset the score and re-open the row.", (v) => Number(v))
        .option("--needs-human-review", "Park the row for a human (excludes it from --needs-review) — set with a low --ai-confidence when you cannot raise it without human input.");
}
/** Attach the AI groom SELECT flags to a list command. */
export function addNeedsReviewFlags(cmd) {
    return cmd
        .option("--needs-review", "Only rows that still need grooming: aiConfidence below the threshold (or never assessed) AND not parked, oldest-first.")
        .option("--max-confidence <n>", "Confidence threshold for --needs-review (default 90).", (v) => Number(v));
}
//# sourceMappingURL=assess.js.map