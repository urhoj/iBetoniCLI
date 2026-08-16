import type { Command } from "commander";
import { failWith } from "./output/json.js";
import { CliError } from "./api/errors.js";
import { closestName } from "./output/nearest.js";
import { resolveDate } from "./dates.js";

/**
 * Commander coercer for a `--limit`-style flag that is clamped to `cap`.
 * Deliberately NOT a validator: a non-numeric value still yields `NaN` (which
 * the backend rejects) — this only reproduces the long-standing clamp, so the
 * ~25 hand-spelled `(v) => Math.min(Number(v), N)` copies stay behaviourally
 * identical.
 */
export function cappedInt(cap: number): (v: string) => number {
  return (v: string) => Math.min(Number(v), cap);
}

/**
 * Guard an OPTIONAL enum-valued flag against its allowed set. `undefined` is a
 * no-op (the flag was not given); anything else outside `allowed` exits 4 with
 * the house message `--flag must be one of: a, b, c`, plus a `— did you mean X?`
 * suffix whenever one candidate stands out.
 *
 * The suffix costs one retry instead of a guess: `closestName` bridges typos
 * (prefix, then edit distance), and `synonyms` bridges the gaps distance cannot
 * — a caller reaching for a DIFFERENT vocabulary rather than fat-fingering this
 * one (`--severity high` for `major`: 5 edits away, so only the table finds it).
 * The listed set always precedes the suffix, so `hintForError`'s "must be one
 * of" substring match keeps resolving the command's own ERRORS remedy.
 *
 * Raised through {@link failWith}, so the error carries `statusCode: 0` —
 * `origin:"client"`, the only shape `hintForError`'s `matchClientRow` will look
 * at. Hand-building the error with a fabricated 400 instead reports a status no
 * server sent AND makes the command's own client ERRORS remedy unreachable.
 */
export function assertEnum(
  value: string | undefined,
  allowed: readonly string[],
  flag: string,
  synonyms?: Record<string, string>
): void {
  if (value !== undefined && !allowed.includes(value)) {
    const guess =
      closestName(value, [...allowed]) ?? synonyms?.[value.trim().toLowerCase()];
    const hint = guess && allowed.includes(guess) ? ` — did you mean ${guess}?` : "";
    failWith(`${flag} must be one of: ${allowed.join(", ")}${hint}`, 4);
  }
}

/**
 * Guard a CSV-expanded list of enum values — the multi-valued sibling of
 * {@link assertEnum}. Reports ALL unknown values at once (failing on just the
 * first bad token invites a retry-per-token loop), exit 4, client-origin via
 * {@link failWith}. `undefined`/empty in → no-op.
 */
export function assertEnumCsv(
  values: readonly string[] | undefined,
  allowed: readonly string[],
  flag: string
): void {
  const unknown = values?.filter((v) => !allowed.includes(v)) ?? [];
  if (unknown.length) {
    failWith(
      `${flag}: unknown value(s) ${unknown.join(", ")} — must be one of: ${allowed.join(", ")}`,
      4
    );
  }
}

/**
 * Guard an already-coerced value that must be a positive integer, emitting the
 * canonical `<label> must be a positive integer` (exit 4, client-origin). `NaN`
 * — what a bare `Number(v)` yields for a typo — fails the `Number.isInteger`
 * arm, so a fat-fingered id cannot reach the wire as `"NaN"`.
 *
 * The value-level twin of {@link parseId}: use that one when parsing a raw
 * positional STRING (it also rejects `"5.5"`/`"0x10"`/`"1e3"`, which are already
 * lost once `Number()` has run), and this one for a Commander-coerced number.
 */
export function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    failWith(`${label} must be a positive integer`, 4);
  }
}

/**
 * Commander argParser: strict integer >= min; exit 4 otherwise. Bare `Number`
 * lets NaN through — the backend silently drops a NaN filter and returns ALL
 * rows (fb#249), and a NaN id serialises as `null` in a JSON body.
 *
 * `hint` is for a flag whose remedy is the SAME on every command that carries
 * it (see {@link addOwnerOption}) — it rides on the error and so wins over the
 * command's spec ERRORS row. Leave it unset otherwise: an argParser throw now
 * resolves the running command's own documented remedy (fb#385), and a blanket
 * hint here would shadow it on every command that has one.
 */
export function intFlag(
  flag: string,
  min = 1,
  hint?: string
): (value: string) => number {
  return (value: string) => {
    const n = Number((value ?? "").trim());
    if (!Number.isSafeInteger(n) || n < min) {
      failWith(`${flag} must be an integer >= ${min}`, 4, hint);
    }
    return n;
  };
}

/**
 * Commander argParser: a comma-separated list of integers >= min; exit 4 on ANY
 * malformed element (fb#576). The CSV sibling of {@link intFlag}.
 *
 * An element shaped like an anchor (`fb#541`, `cl#1281`, letters followed by an
 * optional separator and digits) goes through {@link parseRefId}, so the house
 * `fb#` prefix keeps working per element — `--feedback fb#541,542` is the
 * natural way to write it — and a `cl#` anchor is caught here (wrong ref type)
 * rather than silently linking the wrong table. Anything else is parsed as a
 * bare integer directly, so a typo like "abc" reports THIS flag's own
 * `must be an integer` wording instead of parseRefId's `invalid feedbackId`.
 *
 * A bad element voids the WHOLE list: linking two of three ids and reporting
 * success is the silent-partial-write class this CLI's validation exists to
 * prevent, and the response has no shape that could say which two landed.
 */
export function intCsvFlag(
  flag: string,
  min = 1
): (value: string) => number[] {
  return (value: string) => {
    const parts = (value ?? "").split(",");
    return parts.map((p) => {
      const s = p.trim();
      if (!s) failWith(`${flag} must be an integer >= ${min} (empty element in "${value}")`, 4);
      if (/^[a-z]+[#:_-]?\d+$/i.test(s)) return parseRefId(s, "feedback", "get");
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < min) {
        failWith(`${flag} must be an integer >= ${min} (got "${s}")`, 4);
      }
      return n;
    });
  };
}

/**
 * Commander argParser: finite number within `[min, max]`; exit 4 otherwise. The
 * FLOAT sibling of {@link intFlag}, for the values that are genuinely fractional
 * — coordinates, metres — and so cannot use the integer guard.
 *
 * Same rationale (fb#249, then fb#371): a bare `Number` coercer turns a typo into
 * `NaN`, which is not nullish, so it survives every `?? default` and reaches the
 * wire as the literal `"NaN"` — in a URL PATH segment for weather's lat/lng.
 * Empty is rejected explicitly because `Number("")` is `0`, a plausible-looking
 * coordinate rather than an obvious error.
 *
 * Bounds are opt-in and meant for limits the CLI genuinely owns (`0..999.99`
 * metres for a DECIMAL(5,2) column). Do NOT restate a range the backend already
 * validates — a client copy of a server rule drifts silently.
 */
export function numFlag(
  flag: string,
  min = -Infinity,
  max = Infinity
): (value: string) => number {
  const range =
    Number.isFinite(min) || Number.isFinite(max) ? ` in ${min}..${max}` : "";
  return (value: string) => {
    const trimmed = (value ?? "").trim();
    const n = trimmed === "" ? NaN : Number(trimmed);
    if (!Number.isFinite(n) || n < min || n > max) {
      failWith(`${flag} must be a number${range}`, 4);
    }
    return n;
  };
}

/**
 * Attach the `--asiakas <id>` alias for an optional `[asiakasId]` positional —
 * the dual-target pattern (feedback #28), resolved in the action via
 * {@link resolveTarget} / `resolveAsiakasTarget`. Same shape as
 * `addWriteFlagsToCommand`: takes the command, returns it for chaining.
 * NOT for the cross-tenant `--asiakas` SCOPE overrides (vehicle, sijainti
 * list, …) — those carry their own descriptions and no positional twin.
 */
export function addAsiakasTargetOption(cmd: Command): Command {
  return cmd.option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number);
}

/**
 * Attach the shared `--owner <id>` tenant-SCOPE flag (ownerAsiakasId), the one
 * every changeTracker/audit read and the combinator commands accept. Distinct
 * from {@link addAsiakasTargetOption}: that one aliases a positional TARGET id,
 * this one re-points which tenant's rows are read (default: the active company
 * from the token). Wrap the command at the exact point the flag was registered
 * — Commander renders options in registration order, so moving it would move
 * the `--help` line.
 *
 * Parsed with {@link intFlag}, not a bare `Number`: this value is interpolated
 * into a ROUTE SEGMENT (`/api/changes/latest/:owner`), and `NaN` is not nullish
 * so it survives the `opts.owner ?? resolveActiveOwnerAsiakasId(...)` default
 * and reaches the wire as the literal `"NaN"`. Unlike
 * {@link addAsiakasTargetOption}, whose value is always re-validated by
 * {@link resolveTarget}, nothing downstream re-checks this one.
 *
 * Carries its OWN remedy hint because the flag spans ~11 commands with one
 * meaning, and almost none of them documents it in an ERRORS row — leaving the
 * fb#385 parse-time resolution to fall back on whatever single client/exit-4 row
 * those commands do have (`ib log entity` → "ib log types", `ib log
 * by-entity-date` → "use ISO dates"), which answers a question nobody asked.
 */
export function addOwnerOption(cmd: Command): Command {
  return cmd.option(
    "--owner <id>",
    "ownerAsiakasId (default: active company)",
    intFlag(
      "--owner",
      1,
      "--owner takes an ownerAsiakasId (an integer) — omit it entirely to read the active company, or resolve one with `ib company list`"
    )
  );
}

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

/**
 * Resolve a DATE that may arrive as a positional arg OR a `--date` flag — the
 * date twin of {@link resolveTarget} (feedback #393: `ib vehicle driver board`
 * took a positional while its `vehicle timeline`/`route`/`visits` siblings take
 * `--date`, so an agent moving between them kept spending an exit 4 on the
 * shape alone). Exactly one is required; both are allowed only when they mean
 * the same day, compared AFTER alias expansion so `today` and the matching ISO
 * date agree rather than reading as a conflict.
 *
 * Returns the `resolveDate`-expanded value, so callers still receive
 * `YYYY-MM-DD` (or an unrecognised string passed through for the backend to
 * reject) exactly as the positional-only form did.
 */
export function resolveDateInput(
  positional: string | undefined,
  flag: string | undefined,
  argName = "date"
): string {
  const pos = resolveDate(positional);
  const opt = resolveDate(flag);
  const date = pos ?? opt;
  if (date === undefined) {
    failWith(
      `missing ${argName}: pass <${argName}> positionally or via --${argName} <date> (YYYY-MM-DD, or today/yesterday/tomorrow)`,
      4
    );
  }
  if (pos !== undefined && opt !== undefined && pos !== opt) {
    failWith(
      `positional ${argName} (${positional}) and --${argName} (${flag}) differ — pass only one`,
      4
    );
  }
  return date;
}

/**
 * Resolve a free-TEXT value that may arrive as a positional OR a `--flag`
 * alias — the string sibling of {@link resolveTarget}. Exactly one is
 * required; passing both is allowed only when they match (after trim). A
 * missing / whitespace-only value exits 4.
 */
export function resolveDualString(
  positional: string | undefined,
  flag: string | undefined,
  positionalName: string,
  flagName: string,
  /**
   * Extra remedy appended to the MISSING-value error only. Optional because the
   * generic "pass it positionally or via --flag" already states the mechanics;
   * this is for callers whose value is not guessable from the flag name and who
   * can point at the command that discovers it (`ib dev cache pattern` → run
   * `ib dev cache keys` first to see what a glob matches).
   */
  hint?: string
): string {
  const norm = (s: string | undefined): string | undefined => {
    const t = s?.trim();
    return t ? t : undefined;
  };
  const pos = norm(positional);
  const fl = norm(flag);
  const value = pos ?? fl;
  if (value === undefined) {
    failWith(
      `missing ${positionalName}: pass <${positionalName}> positionally or via --${flagName} <s>`,
      4,
      hint
    );
  }
  if (pos !== undefined && fl !== undefined && pos !== fl) {
    failWith(
      `positional ${positionalName} ("${pos}") and --${flagName} ("${fl}") differ — pass only one`,
      4
    );
  }
  return value;
}

/**
 * Resolve the target asiakasId for commands that accept it positionally OR
 * via --asiakas (the dominant flag across the customer/* and jerry/* groups
 * — feedback #28). Thin wrapper over the generic {@link resolveTarget}.
 * Lives here (not in customer/index.ts) so jerry/message don't drag the whole
 * customer module graph in for a 1-line wrapper.
 */
export function resolveAsiakasTarget(
  positional: string | undefined,
  flag: number | undefined
): number {
  return resolveTarget(positional, flag, "asiakasId", "asiakas");
}

/**
 * `<query>` / `--search <s>` via {@link resolveDualString} (feedback #235).
 * AIs learn the `--search` convention from list commands (`glossary list`,
 * `dev schema tables`) and reach for it on search-style commands too;
 * accepting both spellings removes that friction.
 */
export function resolveSearchQuery(
  positional: string | undefined,
  flag: string | undefined
): string {
  return resolveDualString(positional, flag, "query", "search");
}
