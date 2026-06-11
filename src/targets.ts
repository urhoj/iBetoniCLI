import { failWith } from "./output/json.js";

/**
 * Resolve an entity target that may arrive as a positional arg OR a --flag
 * alias (e.g. `<asiakasId>` / `--asiakas`) — the dual-target pattern from
 * feedback #28. Exactly one is required; giving both is allowed only when
 * they agree. Missing or non-positive-integer target → exit 4.
 */
export function resolveTarget(
  positional: string | undefined,
  flag: number | undefined,
  positionalName: string,
  flagName: string
): number {
  const pos = positional === undefined ? undefined : Number(positional);
  if (pos !== undefined && flag !== undefined && pos !== flag) {
    failWith(
      `positional ${positionalName} (${positional}) and --${flagName} (${flag}) differ — pass only one`,
      4
    );
  }
  const id = pos ?? flag;
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    failWith(
      `missing or invalid target: pass <${positionalName}> positionally or via --${flagName} <id>`,
      4
    );
  }
  return id;
}
