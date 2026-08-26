/**
 * argv pre-parse normalization (fb#856).
 *
 * Agents recurrently write long flags with a SINGLE dash — `jerry admin enable
 * 1431 -reason test` appeared on 2026-08-11 and again 2026-08-21, different
 * sessions, same mistake — and the did-you-mean hint clearly does not prevent
 * the pattern. Since `ib` registers NO short options of its own (only
 * commander's auto `-h`/`-V`, both single-char), a FREE-STANDING token shaped
 * `-name…` with a multi-character name is overwhelmingly a long-flag typo: it
 * is rejected as unknown, and rewriting it to `--name…` turns that broken
 * invocation into the one the caller meant.
 *
 * KNOWN RESIDUALS (documented, pinned by test/argv.test.ts, accepted):
 * 1. A `-word` sitting in a VALUE position (`--title -reason`) used to be
 *    consumed as a literal value; post-rewrite it parses as a flag. Deliberate
 *    dash-led literals must use the equals form (`--title=-reason`), which
 *    starts with `--` and is never rewritten.
 * 2. Commander's combined-shorts expansion (`-hV`) also matches and becomes
 *    the unknown `--hV`. Both shapes were vanishingly rare in practice — the
 *    recurrence this fixes is orders of magnitude more common.
 *
 * Kept deliberately dumb (no command-tree introspection): unknown `--xyz`
 * still lands in the usual unknown-option envelope with the did-you-mean
 * hint, exactly as it does when typed with two dashes.
 */
const SINGLE_DASH_LONG = /^-([a-zA-Z][a-zA-Z0-9-]*)(=.*)?$/;
/**
 * Rewrite single-dash multi-character option tokens to double-dash form.
 * Single-char tokens (`-h`, `-V`, negative numbers like `-1` start with a
 * digit so never match) and everything after a bare `--` terminator are left
 * untouched.
 */
export function normalizeSingleDashLongFlags(argv) {
    const out = [];
    let pastTerminator = false;
    for (const token of argv) {
        if (token === "--")
            pastTerminator = true;
        if (!pastTerminator) {
            const m = SINGLE_DASH_LONG.exec(token);
            if (m && m[1].length >= 2) {
                out.push(`--${m[1]}${m[2] ?? ""}`);
                continue;
            }
        }
        out.push(token);
    }
    return out;
}
//# sourceMappingURL=argv.js.map