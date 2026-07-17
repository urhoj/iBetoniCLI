import { failWith } from "./output/json.js";
import { CliError } from "./api/errors.js";

/**
 * Parse a required primary-key positional id (`<keikkaId>`, `<asiakasId>`, …).
 *
 * `Number(idStr)` alone is unsafe for ids: a typo yields `NaN` (which then
 * interpolates into URLs/bodies as the literal `"NaN"`/`null`), and it silently
 * accepts non-integer forms — `"5.5"`→5.5, `"1e3"`→1000, `"0x10"`→16,
 * `" 7 "`→7 — so a fat-fingered value can hit a *valid wrong row*. Require a
 * canonical positive integer (digits only, > 0); anything else exits 4.
 *
 * @param name field name used in the error message (e.g. "keikkaId").
 */
export function parseId(idStr: string, name: string): number {
  const trimmed = idStr.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(n) || n <= 0) {
    failWith(`invalid ${name}: "${idStr}" — expected a positive integer`, 4);
  }
  return n;
}

/**
 * Like {@link parseId} but for an OPTIONAL positional id: `undefined` in →
 * `undefined` out (the "no id given" case). A provided-but-invalid value still
 * exits 4 rather than silently becoming `NaN`.
 */
export function parseOptionalId(
  idStr: string | undefined,
  name: string
): number | undefined {
  return idStr === undefined ? undefined : parseId(idStr, name);
}

/** The two id-bearing tables whose command shapes collide (feedback #230). */
export type RefType = "feedback" | "changelog";

const REF: Record<
  RefType,
  { prefixes: string[]; field: string; verbs: Set<string> }
> = {
  feedback: { prefixes: ["fb", "f"], field: "feedbackId", verbs: new Set(["get", "resolve", "update"]) },
  changelog: { prefixes: ["cl", "c"], field: "changelogId", verbs: new Set(["get", "delete", "update"]) },
};

/**
 * Parse an id positional that MAY carry an optional `fb#`/`cl#` type anchor
 * (feedback #230). `ib dev feedback get N` and `ib dev changelog get N` are
 * identically shaped over overlapping numeric id spaces, so agents demonstrably
 * cross-wire them. An optional prefix lets a caller ASSERT the type and have it
 * validated up front:
 *
 * - bare number (`230`)                  → validated via {@link parseId} (unchanged path)
 * - matching prefix (feedback ← `fb#230`) → prefix stripped, digits validated
 * - WRONG prefix   (feedback ← `cl#858`)  → exit 4 (code `WRONG_REF_TYPE`) with the
 *   corrective command in the `hint`. NO DB round-trip → **overlap-proof**: it keeps
 *   working after the fb/cl id ranges collide, where the sibling-404 hint cannot.
 *
 * Accepted prefixes (case-insensitive): `fb`/`f` (feedback), `cl`/`c` (changelog),
 * with an optional `#`/`:`/`_`/`-` or no separator — `fb#230`, `FB230`, `cl-858`,
 * `c:858` all parse. The canonical, documented form is `fb#`/`cl#` (the house
 * style already used in prose / MEMORY.md). Ids are digits-only, so any leading
 * letter is unambiguously an anchor attempt.
 *
 * @param type the table this command targets.
 * @param verb the command verb — used only to build the corrective hint (mirrored
 *   to the other command tree when that verb exists there, else `get`).
 */
export function parseRefId(idStr: string, type: RefType, verb: string): number {
  const trimmed = idStr.trim();
  const m = /^([a-z]+)[#:_-]?(\d+)$/i.exec(trimmed);
  // No leading letters → a bare id; let parseId apply its canonical-integer guard.
  if (!m) return parseId(trimmed, REF[type].field);
  const prefix = m[1].toLowerCase();
  const digits = m[2];
  if (REF[type].prefixes.includes(prefix)) return parseId(digits, REF[type].field);
  const other: RefType = type === "feedback" ? "changelog" : "feedback";
  if (REF[other].prefixes.includes(prefix)) {
    const v = REF[other].verbs.has(verb) ? verb : "get";
    throw new CliError(
      `${prefix}#${digits} is a ${other} id, not a ${type} id`,
      0,
      { code: "WRONG_REF_TYPE" },
      4,
      `run: ib dev ${other} ${v} ${digits}`
    );
  }
  // Unknown letter prefix (neither fb/cl) → not an anchor; parseId rejects the
  // whole token with its canonical-integer error (exit 4).
  return parseId(trimmed, REF[type].field);
}

/**
 * Resolve an entity target that may arrive as a positional arg OR a --flag
 * alias (e.g. `<asiakasId>` / `--asiakas`) — the dual-target pattern from
 * feedback #28. Exactly one is required; giving both is allowed only when
 * they agree. Missing or non-positive-integer target → exit 4. A provided
 * value that is not a positive integer is rejected even when the other one
 * is valid (a garbage --flag must not be silently ignored, nor reported as
 * a "differ" mismatch against the positional).
 */
export function resolveTarget(
  positional: string | undefined,
  flag: number | undefined,
  positionalName: string,
  flagName: string
): number {
  const pos = positional === undefined ? undefined : Number(positional);
  const bad = (n: number | undefined): boolean =>
    n !== undefined && (!Number.isInteger(n) || n <= 0);
  const id = pos ?? flag;
  if (id === undefined || bad(pos) || bad(flag)) {
    failWith(
      `missing or invalid target: pass <${positionalName}> positionally or via --${flagName} <id>`,
      4
    );
  }
  if (pos !== undefined && flag !== undefined && pos !== flag) {
    failWith(
      `positional ${positionalName} (${positional}) and --${flagName} (${flag}) differ — pass only one`,
      4
    );
  }
  return id;
}
