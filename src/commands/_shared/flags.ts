import type { Command } from "commander";
import { failWith } from "../../output/json.js";

/**
 * The subset of `o` the caller ACTUALLY typed (as opposed to a Commander
 * default). Drives --from-json precedence: only explicitly-typed flags outrank
 * the JSON object — a flag with a declared default ("patch", "improvement")
 * must not silently override a JSON-supplied value the caller wrote
 * (fb#299/#327/#332). Shared by changelog and feedback's from-json commands.
 */
export function explicitFlags(
  cmd: Command,
  o: Record<string, unknown>,
  keys: Iterable<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (cmd.getOptionValueSource(k) === "cli") out[k] = o[k];
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
export function foldAliases(
  values: ReadonlyArray<string | undefined>,
  conflictMessage: string
): string | undefined {
  const given = values.map((s) => s?.trim()).filter((s): s is string => !!s);
  if (new Set(given).size > 1) failWith(conflictMessage, 4);
  return given[0];
}
