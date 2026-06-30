import { COMMAND_SPECS } from "../reference/specs.js";
import { fullyHiddenDomains } from "../reference/commandsList.js";
import { isHiddenAtTier } from "../tier.js";
/** Classic Levenshtein edit distance (two-row). */
export function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}
/**
 * Closest name to `target` within an edit-distance threshold, else null.
 * A prefix match (`acc`→`accept`, target ≥ 2 chars) always wins; otherwise the
 * minimum edit distance, accepted only when ≤ max(2, floor(len/2)).
 */
export function closestName(target, names) {
    if (!target || names.length === 0)
        return null;
    const t = target.toLowerCase();
    const prefix = names.find((n) => t.length >= 2 && n.toLowerCase().startsWith(t));
    if (prefix)
        return prefix;
    const threshold = Math.max(2, Math.floor(t.length / 2));
    let best = null;
    let bestDist = Infinity;
    for (const n of names) {
        const d = levenshtein(t, n.toLowerCase());
        if (d < bestDist) {
            bestDist = d;
            best = n;
        }
    }
    return best !== null && bestDist <= threshold ? best : null;
}
/** Space-joined path of a command up its parent chain (e.g. "ib legal"). */
export function commandPath(cmd) {
    const parts = [];
    for (let c = cmd; c; c = c.parent)
        parts.unshift(c.name());
    return parts.join(" ");
}
/**
 * Visible subcommand names of `cmd` at `tier`. A leaf with a developer-tier
 * spec is dropped for non-developer callers; a subgroup with no leaf spec of
 * its own (e.g. `legal type`) stays visible.
 */
export function visibleSubcommands(cmd, tier) {
    const base = commandPath(cmd);
    // At the root, domain GROUPS (schema/ai/changelog) have no leaf spec of their
    // own, so the spec-lookup fallback below would keep them visible — apply the
    // same whole-domain hiding `ib --help` uses (program.ts configureHelp).
    const fullyHidden = base === "ib" ? fullyHiddenDomains(tier) : new Set();
    return cmd.commands
        .filter((sub) => {
        // Skip Commander-hidden commands (back-compat aliases registered with
        // { hidden: true }) — they must be invisible everywhere, not just in
        // Commander's own --help renderer.
        if (sub._hidden)
            return false;
        if (fullyHidden.has(sub.name()))
            return false;
        const spec = COMMAND_SPECS.find((s) => s.command === `${base} ${sub.name()}`);
        return spec ? !isHiddenAtTier(spec, tier) : true;
    })
        .map((sub) => sub.name());
}
/**
 * Build the enriched envelope. `cmd` is the GROUP that threw
 * commander.unknownCommand; `unknownToken` is the bad token (cmd.args[0]).
 */
export function buildUnknownCommandEnvelope(cmd, unknownToken, tier) {
    const group = commandPath(cmd);
    const available = visibleSubcommands(cmd, tier);
    const didYouMean = closestName(unknownToken, available);
    const domain = group.split(" ")[1]; // token after `ib`, e.g. legal
    const discover = domain
        ? `\`${group} --help\` or \`ib commands ${domain}\``
        : "`ib --help` or `ib commands`";
    const suggestion = didYouMean ? `Did you mean \`${group} ${didYouMean}\`? ` : "";
    const availableStr = available.length > 0
        ? `Available ${cmd.name()} subcommands: ${available.join(", ")}. `
        : "";
    return {
        success: false,
        error: group === "ib"
            ? `unknown command "${unknownToken}"`
            : `unknown command "${unknownToken}" under \`${group}\``,
        code: "USAGE",
        statusCode: 0,
        group,
        unknownCommand: unknownToken,
        didYouMean,
        available,
        hint: `${suggestion}${availableStr}Run ${discover} to discover them.`,
    };
}
//# sourceMappingURL=unknownCommand.js.map