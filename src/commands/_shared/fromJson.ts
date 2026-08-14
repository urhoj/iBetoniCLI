/**
 * The generic `--from-json <file|->` machinery (fb#298/#299/#300/#357).
 *
 * `--from-json` exists because Windows PowerShell splits a native argument on
 * inner double quotes, so any long or quote-bearing prose passed on argv is
 * mangled (exit 4 "too many arguments", or worse: silently truncated text).
 * Reading a JSON object file sidesteps argv entirely.
 *
 * Extracted from `ib dev changelog` (the hardened implementation) so every
 * command offering the flag shares ONE contract:
 *   - accepted keys are DERIVED from the command's own registered options
 *     ({@link payloadKeyMap}) — a flag added later cannot drift out of
 *     --from-json, and a key no flag backs is rejected;
 *   - unknown keys are REJECTED aggregated with the accepted-key list, and
 *     wrong-typed values are rejected by name ({@link normalizeFromJson}) —
 *     never silently dropped (the fb#298 class);
 *   - precedence is explicit CLI flag > JSON > Commander default
 *     ({@link mergeFromJsonInput}) — the fb#299 trap;
 *   - {@link applyFromJson} composes the three from a per-command
 *     {@link FromJsonConfig} and mutates the action's options object in place.
 */
import type { Command } from "commander";
import { failUsage } from "../../output/json.js";
import { readJsonObjectInput } from "../../api/parseBody.js";
import { explicitFlags } from "./flags.js";

/** Per-command configuration for the `--from-json` pipeline. */
export interface FromJsonConfig {
  /**
   * Option attribute names that are NOT part of the payload: the JSON source
   * itself, the write-safety trio / client-side dry-run, output shaping
   * (--full), and help. Everything else the command registers is a payload
   * field.
   */
  nonPayload: Set<string>;
  /**
   * Column name as the READ commands emit it → the write flag that sets it.
   * The natural way to author a --from-json file is to template it off a row
   * from the matching read command, but the read shape is the DB column names
   * while the write keys are the flag names (feedback #357). Each alias is
   * gated on the target flag actually being registered on the command, so a
   * command that cannot apply the field never silently accepts its read key.
   */
  readShapeAliases?: Record<string, string>;
  /** Payload fields Commander parses with Number — a JSON number (or numeric string) is accepted. */
  numericFields?: Set<string>;
  /** Payload fields whose flag takes a CSV — a --from-json array of strings is joined for these. */
  csvFields?: Set<string>;
  /**
   * The subset of `csvFields` that ALSO accepts a bare JSON number, coerced to
   * its string form (fb#576 fix round 1). Opt-in and separate from `csvFields`
   * on purpose: a csv field is CSV precisely because its elements are usually
   * NOT numeric (file paths, commit SHAs, repo names), so a bare `{"sha": 12345}`
   * is much more likely a caller's mistake than a deliberate single-element
   * list — the "must be a string or an array of strings" rejection is the
   * correct, loud behaviour for those. Only a field whose CSV elements happen
   * to be numeric ids (`--feedback`) should be listed here, and only because
   * the natural way to author it is templating off a read row whose column IS
   * a number (`changelog list`'s `feedbackId`).
   */
  numericTolerantCsvFields?: Set<string>;
  /** Flag name used as the error prefix (default `--from-json`). */
  flagName?: string;
}

/**
 * JSON key → canonical option attribute name, for every payload flag registered
 * on `cmd`. Derived from the command itself instead of a hand-kept list, so
 * sibling commands with different flag sets each accept exactly the keys they
 * can apply. Three spellings resolve: the camelCase attribute (`bumpLevel`),
 * the literal flag (`bump-level`), and the read-shape column name
 * ({@link FromJsonConfig.readShapeAliases}) when that flag is registered here.
 */
export function payloadKeyMap(
  cmd: Command,
  cfg: Pick<FromJsonConfig, "nonPayload" | "readShapeAliases">
): Map<string, string> {
  const m = new Map<string, string>();
  for (const opt of cmd.options) {
    const attr = opt.attributeName();
    if (!opt.long || cfg.nonPayload.has(attr)) continue;
    m.set(attr, attr);
    m.set(opt.long.replace(/^--/, ""), attr);
  }
  // Gated on the target flag actually existing, so a sibling command (a
  // different flag set) never silently accepts a read key it cannot apply.
  for (const [readKey, flag] of Object.entries(cfg.readShapeAliases ?? {})) {
    if (m.has(flag) && !m.has(readKey)) m.set(readKey, m.get(flag)!);
  }
  return m;
}

/**
 * Normalize a --from-json object into flag-shaped fields.
 *
 * Unknown keys are REJECTED (exit 4), not ignored: fb#298 was precisely a
 * silently-dropped JSON key destroying a stored value. Wrong-typed values are
 * rejected by name too — an object where a string flag is expected would
 * otherwise crash downstream (e.g. `.split(",")` as a raw TypeError, exit 1);
 * the CSV fields therefore also ACCEPT an array of strings, which is what a
 * JSON author naturally writes. Every problem is reported together so one
 * re-run fixes all.
 */
export function normalizeFromJson(
  json: Record<string, unknown>,
  keys: Map<string, string>,
  cfg: Pick<FromJsonConfig, "numericFields" | "csvFields" | "numericTolerantCsvFields" | "flagName"> = {}
): Record<string, unknown> {
  const numeric = cfg.numericFields ?? new Set<string>();
  const csv = cfg.csvFields ?? new Set<string>();
  const numericTolerant = cfg.numericTolerantCsvFields ?? new Set<string>();
  const flagName = cfg.flagName ?? "--from-json";
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  const problems: string[] = [];
  for (const [rawKey, value] of Object.entries(json)) {
    const key = keys.get(rawKey);
    if (!key) {
      unknown.push(rawKey);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (numeric.has(key)) {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) problems.push(`"${rawKey}" must be a number`);
      else out[key] = n;
      continue;
    }
    if (csv.has(key) && Array.isArray(value)) {
      if (!value.every((v) => typeof v === "string")) problems.push(`"${rawKey}" array must contain only strings`);
      else out[key] = value.map((v) => v.trim()).filter(Boolean).join(",");
      continue;
    }
    // A field OPTED IN to numeric tolerance (e.g. --feedback, fb#576) round-trips
    // a JSON number too — the natural shape when the JSON was templated off a
    // read row whose column is itself a number (changelog list's feedbackId).
    // Deliberately NOT every csvFields entry: see numericTolerantCsvFields' doc
    // for why a bare number is a real error for files/repo/sha/commit.
    if (numericTolerant.has(key) && typeof value === "number" && Number.isFinite(value)) {
      out[key] = String(value);
      continue;
    }
    if (typeof value !== "string") {
      problems.push(
        `"${rawKey}" must be a string${csv.has(key) ? " or an array of strings" : ""} (got ${Array.isArray(value) ? "array" : typeof value})`
      );
      continue;
    }
    out[key] = value;
  }
  if (unknown.length)
    problems.push(
      `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — accepted: ${[...new Set(keys.values())].sort().join(", ")}`
    );
  if (problems.length) failUsage(`${flagName}: ${problems.join("; ")}`);
  return out;
}

/**
 * Merge a --from-json object with the CLI flags. Precedence: an EXPLICITLY-typed
 * flag wins, then the JSON object, then whatever the option already holds (its
 * Commander default). That middle rung is why `explicit` is passed separately
 * from the raw opts — a flag with a declared default ("patch", "improvement")
 * must not let a default the caller never typed outrank a JSON-supplied value
 * (the precedence trap fb#299 hit on --kind/--scope).
 */
export function mergeFromJsonInput(
  json: Record<string, unknown>,
  explicit: Record<string, unknown>,
  defaults: Record<string, unknown> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(defaults), ...Object.keys(json), ...Object.keys(explicit)])) {
    const v = explicit[k] ?? json[k] ?? defaults[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Apply a `--from-json <file|->` payload onto the action's options object, in
 * place. No-op without the flag. Reads the file (or stdin) via the shared
 * shell-safe reader, validates the object against the command's OWN flags
 * (per `cfg`), and merges it UNDER the explicitly-typed flags.
 */
export function applyFromJson(cmd: Command, o: Record<string, unknown>, cfg: FromJsonConfig): void {
  if (o.fromJson === undefined) return;
  const keys = payloadKeyMap(cmd, cfg);
  const json = normalizeFromJson(readJsonObjectInput(String(o.fromJson)), keys, cfg);
  Object.assign(o, mergeFromJsonInput(json, explicitFlags(cmd, o, new Set(keys.values())), o));
}
