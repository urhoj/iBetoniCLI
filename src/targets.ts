import { failWith } from "./output/json.js";

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
