/**
 * Prescriptive, AGGREGATED validation errors (feedback #204).
 *
 * When a command rejects on missing or invalid flags, an AI caller should get
 * back EVERY problem at once — each with the flag's allowed values and a
 * copy-paste sample invocation — so it re-runs correctly in one shot instead of
 * climbing a one-error-at-a-time ladder or doing a `--help` round-trip.
 *
 * This module is the single builder for that envelope shape. It is PURE (no I/O,
 * no COMMAND_SPECS import → no module cycle): the caller injects the matching
 * {@link CommandSpec} when it has one, and the builder enriches each problem's
 * `allowed`/`synonyms` from `spec.flags` and derives `sample` from the spec's
 * first example. Both error layers emit the same shape:
 *   - the parser layer (`program.ts` missing-required branch) calls it directly;
 *   - the action layer (`failValidation` in `json.ts`) wraps it in a CliError.
 */
import type { CommandSpec, CommandFlag } from "./help.js";

/** The generic "next step" hint shared by every usage/validation envelope. */
export const USAGE_HINT =
  "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands";

/** One flag-level problem in a validation failure. */
export interface FlagProblem {
  /** The flag with its leading dashes, e.g. `--type`. */
  flag: string;
  /** `missing` = required flag absent; `invalid` = present but not an allowed value. */
  issue: "missing" | "invalid";
  /** The rejected value (only on `invalid`). */
  got?: string;
  /** Accepted values; filled from the spec when the caller omits it. */
  allowed?: string[];
  /** Accepted input synonyms → canonical value (e.g. `{ fix: "bugfix" }`). */
  synonyms?: Record<string, string>;
  /**
   * Targeted next step for THIS problem when the mistake is recognizable
   * (e.g. a repo name passed to --area → "pass --repo <name> instead",
   * feedback #212). Complements the envelope-level generic `hint`.
   */
  remedy?: string;
}

/** The prescriptive validation envelope emitted to stderr (exit 4). */
export interface ValidationEnvelope {
  success: false;
  error: string;
  code: "USAGE";
  statusCode: 0;
  problems: FlagProblem[];
  /** A copy-paste-ready sample invocation (the command's first spec example). */
  sample?: string;
  hint: string;
}

/** Strip leading dashes from a flag token: `--bump-level` → `bump-level`. */
function bareName(flag: string): string {
  return flag.replace(/^-+/, "").trim();
}

/**
 * Hint used instead of {@link USAGE_HINT} when EVERY problem already carries its
 * allowed values (fb#2680): sending the caller to `--help` for values that are
 * in this very envelope cost a round-trip.
 */
export const ALLOWED_VALUES_HINT =
  "usage error — the accepted values are in problems[].allowed (and the error text); re-run with one of them";

/**
 * Human one-line summary listing the missing/invalid flags. Each invalid value
 * names its allowed values inline (fb#2680) — `error` is the field a caller
 * reads first, and a bare "invalid value: --area=orders" read as no guidance.
 */
function summarize(commandPath: string, problems: FlagProblem[]): string {
  const missing = problems.filter((p) => p.issue === "missing").map((p) => p.flag);
  const invalid = problems.filter((p) => p.issue === "invalid");
  const parts: string[] = [];
  if (missing.length)
    parts.push(
      `missing required ${missing.length === 1 ? "flag" : "flags"}: ${missing.join(", ")}`
    );
  if (invalid.length)
    parts.push(
      `invalid ${invalid.length === 1 ? "value" : "values"}: ${invalid
        .map((p) => `${p.flag}=${p.got ?? ""}${p.allowed?.length ? ` (allowed: ${p.allowed.join("|")})` : ""}`)
        .join(", ")}`
    );
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
export function buildValidationEnvelope(
  commandPath: string,
  problems: FlagProblem[],
  opts: { spec?: CommandSpec; sample?: string } = {}
): ValidationEnvelope {
  const flagByName = new Map<string, CommandFlag>(
    (opts.spec?.flags ?? []).map((f) => [f.name, f])
  );
  const enriched: FlagProblem[] = problems.map((p) => {
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
