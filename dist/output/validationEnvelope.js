/** The generic "next step" hint shared by every usage/validation envelope. */
export const USAGE_HINT = "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands";
/** Strip leading dashes from a flag token: `--bump-level` → `bump-level`. */
function bareName(flag) {
    return flag.replace(/^-+/, "").trim();
}
/** Human one-line summary listing the missing/invalid flags. */
function summarize(commandPath, problems) {
    const missing = problems.filter((p) => p.issue === "missing").map((p) => p.flag);
    const invalid = problems.filter((p) => p.issue === "invalid");
    const parts = [];
    if (missing.length)
        parts.push(`missing required ${missing.length === 1 ? "flag" : "flags"}: ${missing.join(", ")}`);
    if (invalid.length)
        parts.push(`invalid ${invalid.length === 1 ? "value" : "values"}: ${invalid
            .map((p) => `${p.flag}=${p.got ?? ""}`)
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
        hint: USAGE_HINT,
    };
}
//# sourceMappingURL=validationEnvelope.js.map