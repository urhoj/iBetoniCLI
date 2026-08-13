import { failWith, warnNote } from "../../output/json.js";
/**
 * Control characters that PowerShell's backtick escapes inject into prose, and
 * that no caller types on purpose: NUL/BEL/BS (`0 `a `b), VT/FF (`v `f) and a
 * LONE CR (`r) — CRLF is excluded because a genuinely multi-line argv value has
 * it. TAB (`t) and LF (`n) are excluded outright: both are legitimate in prose,
 * so flagging them would cry wolf and get the whole warning ignored.
 *
 * Measured, not assumed (fb#552): `ib feedback create "the `resolve` key"` arrives
 * as char codes 13,101,115,111,108,118,101 — CR + "esolve". The backtick does NOT
 * survive as a backslash; it is consumed and its escape sequence is expanded.
 */
// Matching control characters IS the point here: they are the damage this detector
// exists to find, not an accident.
// eslint-disable-next-line no-control-regex
const SHELL_MANGLED = /[\u0000-\u0008\u000B\u000C]|\r(?!\n)/;
/**
 * Warn when argv-supplied prose looks like PowerShell already damaged it.
 *
 * The backtick is PowerShell's ESCAPE character, so unlike the inner-double-quote
 * split — which is loud, exiting 4 with "too many arguments" — it is consumed
 * silently and the command SUCCEEDS: `resolve` becomes CR + "esolve", exit 0, no
 * diagnostic, and the mangled text becomes the permanent record on a feedback
 * resolution or changelog entry nobody re-reads (fb#552, observed live).
 *
 * Best-effort and stderr-only: it fires on text that is ALREADY corrupted, so a
 * false positive costs one ignorable line while a miss costs a damaged record.
 * It cannot catch every case — a backtick before a letter with no escape meaning
 * is simply dropped, losing the markdown but not the words — so `--from-json`
 * remains the actual guarantee. Never blocks the write.
 */
export function warnIfShellMangled(values, warn = warnNote) {
    const hits = Object.entries(values)
        .filter(([, v]) => typeof v === "string" && SHELL_MANGLED.test(v))
        .map(([flag]) => `--${flag}`);
    if (!hits.length)
        return;
    warn(`[ib] ⚠ ${hits.join(", ")} contains a control character mid-text — on Windows PowerShell that is the signature of an EATEN BACKTICK: inside a double-quoted argument \`r/\`n/\`t are escape sequences, so a markdown \`resolve\` is stored as CR+"esolve", silently and with exit 0. The text is being written AS-IS. Re-send the prose via --from-json <file|-> (see \`ib help shell-quoting\`).`);
}
/**
 * The subset of `o` the caller ACTUALLY typed (as opposed to a Commander
 * default). Drives --from-json precedence: only explicitly-typed flags outrank
 * the JSON object — a flag with a declared default ("patch", "improvement")
 * must not silently override a JSON-supplied value the caller wrote
 * (fb#299/#327/#332). Shared by changelog and feedback's from-json commands.
 */
export function explicitFlags(cmd, o, keys) {
    const out = {};
    for (const k of keys)
        if (cmd.getOptionValueSource(k) === "cli")
            out[k] = o[k];
    return out;
}
/**
 * Fold alias spellings of ONE value (a positional + its flag aliases) into a
 * single trimmed value. Every non-empty value given must agree after trim —
 * otherwise exit 4 with `conflictMessage`. Returns `undefined` when none was
 * given (the caller decides whether that is an error). Replaces four private
 * copies of the agreement rule (changelog add/update, feedback create/update)
 * whose error wordings had already drifted apart.
 */
export function foldAliases(values, conflictMessage) {
    const given = values.map((s) => s?.trim()).filter((s) => !!s);
    if (new Set(given).size > 1)
        failWith(conflictMessage, 4);
    return given[0];
}
//# sourceMappingURL=flags.js.map