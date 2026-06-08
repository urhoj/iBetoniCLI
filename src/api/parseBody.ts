import { CliError } from "./errors.js";

/**
 * Parse a `--body <json>` flag value into a plain object. A malformed body is
 * caller/validation input, so failures surface as a CliError mapped to exit 4
 * (validation) instead of the generic exit 1 a raw SyntaxError would produce.
 */
export function parseJsonBodyFlag(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new CliError(`Invalid --body JSON: ${detail}`, 400, null, 4);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--body must be a JSON object", 400, null, 4);
  }
  return parsed as Record<string, unknown>;
}
