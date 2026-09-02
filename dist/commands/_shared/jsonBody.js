import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { failValidation } from "../../output/json.js";
import { commandPath, specForPath } from "../../output/unknownCommand.js";
/** The option pair, in the order help renders them. Chainable. */
export function addJsonBodyOptions(cmd) {
    // `<file|->` not `<file>`: stdin is accepted, and every spec description and
    // error remedy already says so — the placeholder was the only spelling that
    // understated the contract.
    return cmd.option("--body <json>").option("--from-json <file|->");
}
/**
 * Resolve the JSON-object payload from whichever of the two flags was passed.
 *
 * `required: true` replaces what `.requiredOption("--body")` used to do. It has
 * to be a RUNTIME check now, because Commander's own required-option gate fires
 * during parse — before it has looked at anything else — so a command that kept
 * `--body` mandatory would answer `ib X --from-json f.json` with "missing
 * required flag: --body", masking the fact that the caller's payload was already
 * supplied (and, before this change, that `--from-json` was not even accepted;
 * that masking shape is fb#1179). The envelope emitted here is the same
 * `failValidation` shape the parser layer emits — same `problems[]`, same
 * spec-derived `sample` — so the only visible difference is the added remedy
 * naming the file route.
 */
export function resolveJsonBody(cmd, o, { required = false } = {}) {
    const parsed = resolveJsonObjectBody({ body: o.body, fromJson: o.fromJson });
    if (parsed || !required)
        return parsed;
    const path = commandPath(cmd);
    failValidation(path, [
        {
            flag: "--body",
            issue: "missing",
            remedy: "pass the JSON object inline with --body, or from a file with --from-json <file|-> (the shell-safe route on Windows PowerShell, which splits an inline value on its inner double-quotes)",
        },
    ], { spec: specForPath(path) });
}
/** `bumpLevel` → `--bump-level`, the spelling every envelope and spec uses. */
const longFlagOf = (attr) => `--${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
/**
 * Runtime stand-in for `.requiredOption(...)` on a command that ALSO accepts
 * `--from-json`.
 *
 * Commander's own required-option gate fires during parse, before any value
 * from a `--from-json` document has been merged in, so a still-mandatory flag
 * rejects the very invocation the file route exists to enable: `ib message chat
 * send --from-json msg.json` would answer "missing required flag: --body" while
 * holding the body in its hand. Checking after {@link applyFromJson} instead
 * keeps the requirement and lets either spelling satisfy it.
 *
 * The envelope is `failValidation`'s, which is the same builder the parser
 * branch uses — identical `problems[]`, spec-derived `sample`, exit 4 — so
 * nothing regresses for the caller who simply forgot the flag.
 */
export function requireFlags(cmd, o, attrs) {
    const bad = attrs.filter((a) => o[a] === undefined || o[a] === "");
    if (!bad.length)
        return;
    const path = commandPath(cmd);
    failValidation(path, bad.map((a) => {
        // An EMPTY value is not an absent one. Reporting `issue: "missing"` with
        // "supply it as a key in --from-json" told a caller who had done exactly
        // that to do it again; the value arrived, it was just blank (fb#1187).
        const empty = o[a] === "";
        return {
            flag: longFlagOf(a),
            issue: empty ? "invalid" : "missing",
            ...(empty ? { got: "" } : {}),
            remedy: empty
                ? `${longFlagOf(a)} arrived empty — give it a value (an empty string cannot stand in for it)`
                : `pass ${longFlagOf(a)}, or supply it as a key in --from-json <file|->`,
        };
    }), { spec: specForPath(path) });
}
//# sourceMappingURL=jsonBody.js.map