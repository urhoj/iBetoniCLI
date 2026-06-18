import { failWith } from "./output/json.js";
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
export function parseId(idStr, name) {
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
export function parseOptionalId(idStr, name) {
    return idStr === undefined ? undefined : parseId(idStr, name);
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
export function resolveTarget(positional, flag, positionalName, flagName) {
    const pos = positional === undefined ? undefined : Number(positional);
    const bad = (n) => n !== undefined && (!Number.isInteger(n) || n <= 0);
    const id = pos ?? flag;
    if (id === undefined || bad(pos) || bad(flag)) {
        failWith(`missing or invalid target: pass <${positionalName}> positionally or via --${flagName} <id>`, 4);
    }
    if (pos !== undefined && flag !== undefined && pos !== flag) {
        failWith(`positional ${positionalName} (${positional}) and --${flagName} (${flag}) differ — pass only one`, 4);
    }
    return id;
}
//# sourceMappingURL=targets.js.map