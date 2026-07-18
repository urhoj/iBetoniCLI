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
 * Verb synonyms an AI naturally reaches for but that edit distance can't bridge
 * (feedback #229): the `add` (changelog) vs `create` (every other group) split,
 * and `show`/`view` for the canonical `get`. Consulted only after prefix + edit
 * distance both miss, so a real near-match always wins. Keyed by the mistyped
 * verb → the canonical sibling(s) to try, in order.
 */
const VERB_SYNONYMS = {
    add: ["create"],
    create: ["add"],
    show: ["get"],
    view: ["get"],
};
/**
 * Closest name to `target` within an edit-distance threshold, else null.
 * A prefix match (`acc`→`accept`, target ≥ 2 chars) always wins; then the
 * minimum edit distance, accepted only when ≤ max(2, floor(len/2)); finally a
 * known verb-synonym (`add`→`create`, `show`→`get`) present among `names`.
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
    if (best !== null && bestDist <= threshold)
        return best;
    // Edit distance missed — fall back to a known verb synonym present in `names`.
    for (const syn of VERB_SYNONYMS[t] ?? []) {
        const hit = names.find((n) => n.toLowerCase() === syn);
        if (hit)
            return hit;
    }
    return null;
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
/**
 * Curated cross-command redirects for flags an AI naturally guesses on the
 * WRONG command — where the right form lives on a sibling command, not just a
 * differently-named flag here (so a same-command "did you mean" can't express
 * it). Keyed by `"<full command path> <flag>"`. Consulted only at runtime by
 * {@link buildUnknownOptionEnvelope}, and only when the caller actually invoked
 * that exact command — so it never leaks into the spec-driven reference dump
 * (keeping the tier-scrub contract intact) and appears solely to a caller who
 * already reached that subtree. The flag analogue of `VERB_SYNONYMS`.
 */
export const OPTION_REDIRECTS = {
    "ib dev cache invalidate --pattern": "`cache invalidate` targets an entity FAMILY by its <entityType> positional (e.g. `ib dev cache invalidate keikka --id 123`). For a raw Redis key glob use `ib dev cache pattern <glob>` instead.",
};
/** Long flags a command accepts, derived from its curated spec (tier-blind — the
 *  caller already invoked this command; only sibling ENUMERATION is tier-gated). */
function specOptionLongs(spec) {
    const longs = spec.flags.map((f) => `--${f.name}`);
    if (spec.writeFlags)
        longs.push("--dry-run", "--idempotency-key", "--reason");
    return longs;
}
/** Real long options wired on a Commander command (fallback when no spec — e.g.
 *  a hidden back-compat alias). Drops the framework-added `--help`. */
function commanderOptionLongs(cmd) {
    return cmd.options
        .map((o) => o.long)
        .filter((l) => Boolean(l) && l !== "--help");
}
/** Positional signature of a command from its spec: `<query>` / `[<query>]`. */
function specPositionals(spec) {
    return (spec.args ?? []).map((a) => a.required === false ? `[<${a.name}>]` : `<${a.name}>`);
}
/**
 * Enriched "unknown option" error envelope — the flag analogue of
 * {@link buildUnknownCommandEnvelope}. When Commander rejects a guessed flag
 * (`ib customer search --search X`) the default USAGE envelope only echoes
 * "unknown option '--search'" with a generic hint — a dead end that doesn't say
 * what the command DOES accept (feedback #235/#236). This lists the command's
 * real positionals + flags, a fuzzy "did you mean" among its actual flags, and
 * (when present) a curated cross-command redirect. `cmd` is the command that
 * threw (a leaf — options belong to leaves); `unknownOption` is the bad flag
 * verbatim incl. leading dashes (e.g. `--search`).
 */
export function buildUnknownOptionEnvelope(cmd, unknownOption) {
    const command = commandPath(cmd);
    const spec = COMMAND_SPECS.find((s) => s.command === command);
    const availableOptions = spec ? specOptionLongs(spec) : commanderOptionLongs(cmd);
    const positionals = spec ? specPositionals(spec) : [];
    const bare = unknownOption.replace(/^-+/, "");
    const guess = closestName(bare, availableOptions.map((o) => o.replace(/^-+/, "")));
    const didYouMean = guess ? `--${guess}` : null;
    const redirect = OPTION_REDIRECTS[`${command} ${unknownOption}`];
    const domain = command.split(" ")[1]; // token after `ib`, e.g. customer
    const discover = domain
        ? `\`${command} --help\` or \`ib commands ${domain}\``
        : "`ib --help` or `ib commands`";
    const parts = [];
    if (redirect)
        parts.push(redirect);
    if (didYouMean)
        parts.push(`Did you mean \`${didYouMean}\`?`);
    if (positionals.length) {
        parts.push(`This command takes positional argument(s): ${positionals.join(" ")}.`);
    }
    parts.push(availableOptions.length
        ? `Accepted flags: ${availableOptions.join(", ")}.`
        : "This command takes no command-specific flags.");
    parts.push(`Run ${discover} for the full spec.`);
    return {
        success: false,
        error: `unknown option "${unknownOption}" on \`${command}\``,
        code: "USAGE",
        statusCode: 0,
        command,
        unknownOption,
        didYouMean,
        availableOptions,
        positionals,
        hint: parts.join(" "),
    };
}
//# sourceMappingURL=unknownCommand.js.map