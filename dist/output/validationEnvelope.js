/** The generic "next step" hint shared by every usage/validation envelope. */
export const USAGE_HINT = "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands";
/** Strip leading dashes from a flag token: `--bump-level` → `bump-level`. */
function bareName(flag) {
    return flag.replace(/^-+/, "").trim();
}
/**
 * Hint used instead of {@link USAGE_HINT} when EVERY problem already carries its
 * allowed values (fb#2680): sending the caller to `--help` for values that are
 * in this very envelope cost a round-trip.
 */
export const ALLOWED_VALUES_HINT = "usage error — the accepted values are in problems[].allowed (and the error text); re-run with one of them";
/**
 * Human one-line summary listing the missing/invalid flags. Each invalid value
 * names its allowed values inline (fb#2680) — `error` is the field a caller
 * reads first, and a bare "invalid value: --area=orders" read as no guidance.
 */
function summarize(commandPath, problems) {
    const missing = problems.filter((p) => p.issue === "missing").map((p) => p.flag);
    const invalid = problems.filter((p) => p.issue === "invalid");
    const parts = [];
    if (missing.length)
        parts.push(`missing required ${missing.length === 1 ? "flag" : "flags"}: ${missing.join(", ")}`);
    if (invalid.length)
        parts.push(`invalid ${invalid.length === 1 ? "value" : "values"}: ${invalid
            .map((p) => `${p.flag}=${p.got ?? ""}${p.allowed?.length ? ` (allowed: ${p.allowed.join("|")})` : ""}`)
            .join(", ")}`);
    return `${parts.join("; ") || "invalid arguments"} for ${commandPath}`;
}
/**
 * Build the prescriptive validation envelope for `commandPath`.
 *
 * Each problem is enriched (non-destructively) from the injected `spec`: a
 * problem that omits `allowed`/`synonyms` inherits them from the matching
 * `spec.flags[].allowed`/`.synonyms`. `sample` is taken from `spec.examples[0]`.
 * With no spec, the caller's problems pass through unchanged and `sample` is
 * omitted (unless supplied via `opts.sample`).
 */
export function buildValidationEnvelope(commandPath, problems, opts = {}) {
    const flagByName = new Map((opts.spec?.flags ?? []).map((f) => [f.name, f]));
    const enriched = problems.map((p) => {
        const specFlag = flagByName.get(bareName(p.flag));
        const allowed = p.allowed ?? specFlag?.allowed;
        const synonyms = p.synonyms ?? specFlag?.synonyms;
        return {
            ...p,
            ...(allowed ? { allowed } : {}),
            ...(synonyms ? { synonyms } : {}),
        };
    });
    const sample = opts.sample ?? opts.spec?.examples?.[0];
    return {
        success: false,
        error: summarize(commandPath, enriched),
        code: "USAGE",
        statusCode: 0,
        problems: enriched,
        ...(sample ? { sample } : {}),
        hint: enriched.every((p) => p.allowed?.length) ? ALLOWED_VALUES_HINT : USAGE_HINT,
    };
}
//# sourceMappingURL=validationEnvelope.js.map