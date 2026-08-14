import { failUsage } from "../../output/json.js";
import { readJsonObjectInput } from "../../api/parseBody.js";
import { explicitFlags } from "./flags.js";
/**
 * JSON key → canonical option attribute name, for every payload flag registered
 * on `cmd`. Derived from the command itself instead of a hand-kept list, so
 * sibling commands with different flag sets each accept exactly the keys they
 * can apply. Three spellings resolve: the camelCase attribute (`bumpLevel`),
 * the literal flag (`bump-level`), and the read-shape column name
 * ({@link FromJsonConfig.readShapeAliases}) when that flag is registered here.
 */
export function payloadKeyMap(cmd, cfg) {
    const m = new Map();
    for (const opt of cmd.options) {
        const attr = opt.attributeName();
        if (!opt.long || cfg.nonPayload.has(attr))
            continue;
        m.set(attr, attr);
        m.set(opt.long.replace(/^--/, ""), attr);
    }
    // Gated on the target flag actually existing, so a sibling command (a
    // different flag set) never silently accepts a read key it cannot apply.
    for (const [readKey, flag] of Object.entries(cfg.readShapeAliases ?? {})) {
        if (m.has(flag) && !m.has(readKey))
            m.set(readKey, m.get(flag));
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
export function normalizeFromJson(json, keys, cfg = {}) {
    const numeric = cfg.numericFields ?? new Set();
    const csv = cfg.csvFields ?? new Set();
    const flagName = cfg.flagName ?? "--from-json";
    const out = {};
    const unknown = [];
    const problems = [];
    for (const [rawKey, value] of Object.entries(json)) {
        const key = keys.get(rawKey);
        if (!key) {
            unknown.push(rawKey);
            continue;
        }
        if (value === null || value === undefined)
            continue;
        if (numeric.has(key)) {
            const n = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(n))
                problems.push(`"${rawKey}" must be a number`);
            else
                out[key] = n;
            continue;
        }
        if (csv.has(key) && Array.isArray(value)) {
            if (!value.every((v) => typeof v === "string"))
                problems.push(`"${rawKey}" array must contain only strings`);
            else
                out[key] = value.map((v) => v.trim()).filter(Boolean).join(",");
            continue;
        }
        // A csv field that happens to hold a single NUMERIC element (e.g. --feedback,
        // fb#576) round-trips a JSON number too — the natural shape when the JSON was
        // templated off a read row whose column is itself a number (changelog list's
        // feedbackId). A bare number is otherwise indistinguishable from every other
        // wrong-typed value below, so it needs its own branch ahead of that check.
        if (csv.has(key) && typeof value === "number" && Number.isFinite(value)) {
            out[key] = String(value);
            continue;
        }
        if (typeof value !== "string") {
            problems.push(`"${rawKey}" must be a string${csv.has(key) ? " or an array of strings" : ""} (got ${Array.isArray(value) ? "array" : typeof value})`);
            continue;
        }
        out[key] = value;
    }
    if (unknown.length)
        problems.push(`unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — accepted: ${[...new Set(keys.values())].sort().join(", ")}`);
    if (problems.length)
        failUsage(`${flagName}: ${problems.join("; ")}`);
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
export function mergeFromJsonInput(json, explicit, defaults = {}) {
    const out = {};
    for (const k of new Set([...Object.keys(defaults), ...Object.keys(json), ...Object.keys(explicit)])) {
        const v = explicit[k] ?? json[k] ?? defaults[k];
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
/**
 * Apply a `--from-json <file|->` payload onto the action's options object, in
 * place. No-op without the flag. Reads the file (or stdin) via the shared
 * shell-safe reader, validates the object against the command's OWN flags
 * (per `cfg`), and merges it UNDER the explicitly-typed flags.
 */
export function applyFromJson(cmd, o, cfg) {
    if (o.fromJson === undefined)
        return;
    const keys = payloadKeyMap(cmd, cfg);
    const json = normalizeFromJson(readJsonObjectInput(String(o.fromJson)), keys, cfg);
    Object.assign(o, mergeFromJsonInput(json, explicitFlags(cmd, o, new Set(keys.values())), o));
}
//# sourceMappingURL=fromJson.js.map