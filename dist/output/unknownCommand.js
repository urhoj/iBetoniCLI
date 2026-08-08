import { COMMAND_SPECS } from "../reference/specs.js";
import { canonicalPath } from "../reference/aliasPaths.js";
import { fullyHiddenDomains } from "../reference/commandsList.js";
import { isHiddenAtTier } from "../tier.js";
// The matcher itself lives in the leaf module ./nearest.js so `targets.ts`
// (assertEnum's did-you-mean) can reach it without importing this file, which
// pulls reference/specs.js and would close an import cycle. Re-exported here:
// both names are part of this module's public surface for its callers/tests.
export { levenshtein, closestName } from "./nearest.js";
import { closestName } from "./nearest.js";
const ASIAKAS_PAIR_WHY = "both name the same `asiakas` entity: `ib company` is the tenant LENS your token acts through, `ib customer` is the record";
export const GROUP_SIBLING_DOMAINS = {
    company: { domain: "customer", why: ASIAKAS_PAIR_WHY },
    customer: { domain: "company", why: ASIAKAS_PAIR_WHY },
};
/**
 * The sibling group's `ib <domain> <token>` command, when the pair is declared
 * in {@link GROUP_SIBLING_DOMAINS} AND that command actually exists and is
 * visible at `tier`. Empty otherwise — a suggestion that 404s at the parser, or
 * names a command hidden at the caller's access level, is worse than none.
 *
 * `group` is a top-level domain group path (`ib company`); nested groups
 * (`ib jerry offer`) never match, so `parts.length !== 2` returns early.
 */
export function siblingGroupsWithCommand(group, token, tier) {
    const parts = group.split(" ");
    if (parts.length !== 2)
        return [];
    const sibling = GROUP_SIBLING_DOMAINS[parts[1]];
    if (!sibling)
        return [];
    const path = `ib ${sibling.domain} ${token}`;
    const spec = COMMAND_SPECS.find((s) => s.command === path);
    if (!spec || isHiddenAtTier(spec, tier))
        return [];
    return [{ path, why: sibling.why }];
}
/**
 * Descendant leaves inside `group`'s OWN subtree whose final VERB is the
 * unknown token (fb#379): `ib keikka assign` dead-ends although
 * `ib keikka drivers assign` exists — `available` names the subgroup but
 * nothing says the verb lives inside it. DERIVED from COMMAND_SPECS like
 * {@link siblingsAcceptingOption}, not curated: scoped to the group's own
 * subtree, so the everyone-owns-a-`get` noise that keeps
 * {@link GROUP_SIBLING_DOMAINS} curated cannot arise. Never fires at the root
 * (`ib list` would match a `list` in every domain — pure noise). Tier-gated
 * (enumeration secrecy) and capped at 3.
 */
export function descendantsOwningVerb(group, token, tier) {
    if (!token || group === "ib")
        return [];
    const base = canonicalPath(group);
    const t = token.toLowerCase();
    return COMMAND_SPECS.filter((s) => {
        if (!s.command.startsWith(`${base} `))
            return false;
        const rest = s.command.slice(base.length + 1).split(" ");
        // At least one subgroup between the group and the verb — depth-1 matches
        // are real siblings and already covered by `available`/didYouMean.
        return rest.length >= 2 && rest[rest.length - 1].toLowerCase() === t && !isHiddenAtTier(s, tier);
    })
        .map((s) => s.command)
        .slice(0, 3);
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
    // Cross-group redirect first — it is the actionable answer, where the
    // in-group list is only context. Rendered with the caller's remaining args
    // (`ib customer get 8`, not `ib customer get`) so it is copy-paste runnable;
    // cmd.args holds the bad token followed by whatever came after it.
    const elsewhere = siblingGroupsWithCommand(group, unknownToken, tier);
    // Only when no curated pair answered: the verb may live in a CHILD subgroup
    // of this very group (fb#379) — same copy-paste rendering.
    const descendants = elsewhere.length ? [] : descendantsOwningVerb(group, unknownToken, tier);
    const rest = (cmd.args ?? []).slice(1).map(String);
    const crossGroup = elsewhere.length
        ? `\`${group} ${unknownToken}\` does not exist, but \`${[elsewhere[0].path, ...rest].join(" ")}\` does — ${elsewhere[0].why}. `
        : descendants.length === 1
            ? `\`${group} ${unknownToken}\` does not exist, but \`${[descendants[0], ...rest].join(" ")}\` does — the verb lives in a subgroup of this command. `
            : descendants.length > 1
                ? `\`${group} ${unknownToken}\` does not exist, but the verb exists deeper in this group: ${descendants.map((d) => `\`${d}\``).join(", ")}. `
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
        availableElsewhere: [...elsewhere.map((e) => e.path), ...descendants],
        hint: `${crossGroup}${suggestion}${availableStr}Run ${discover} to discover them.`,
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
 * Sibling commands in the SAME domain whose spec accepts the rejected flag
 * (feedback #308: `ib person list --search X` was a dead end even though
 * `ib person search` owns exactly that capability — two failed invocations
 * before the right command was found).
 *
 * Derived from `COMMAND_SPECS`, so it covers every domain automatically rather
 * than needing a hand-written {@link OPTION_REDIRECTS} row per case. Sibling
 * ENUMERATION is tier-gated — the caller already reached this command, but must
 * not learn of one hidden at their level.
 *
 * Capped at 3, and a leaf NAMED after the flag (`--search` → `person search`)
 * wins over catalogue order, since that is the strongest signal of which
 * sibling actually owns the capability.
 */
export function siblingsAcceptingOption(command, unknownOption, tier) {
    const domain = command.split(" ")[1];
    if (!domain)
        return [];
    const flag = `--${unknownOption.replace(/^-+/, "")}`;
    const hits = COMMAND_SPECS.filter((s) => s.command !== command &&
        s.command.split(" ")[1] === domain &&
        !isHiddenAtTier(s, tier) &&
        specOptionLongs(s).includes(flag)).map((s) => s.command);
    const named = hits.filter((c) => c.endsWith(` ${flag.slice(2)}`));
    return (named.length ? named : hits).slice(0, 3);
}
/**
 * Recognize a surplus positional that is unmistakably a DATE, and normalize it
 * to the `YYYY-MM-DD` the CLI documents (feedback #328).
 *
 * Accepts the forms a caller actually reaches for: the documented `YYYY-MM-DD`,
 * compact `YYYYMMDD` (what was typed in both captured instances), Finnish
 * `D.M.YYYY`, and the relative keywords `resolveDate` already expands. Returns
 * null for anything else — a wrong suggestion is worse than none, so the bar is
 * "obviously a date", not "might parse as one".
 */
export function asDateSuggestion(token) {
    const t = token.trim();
    if (/^(today|yesterday|tomorrow)$/i.test(t))
        return t.toLowerCase();
    const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso)
        return isRealDate(+iso[1], +iso[2], +iso[3]) ? t : null;
    const compact = t.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) {
        const [, y, m, d] = compact;
        return isRealDate(+y, +m, +d) ? `${y}-${m}-${d}` : null;
    }
    const fi = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (fi) {
        const [, d, m, y] = fi;
        const pad = (s) => s.padStart(2, "0");
        return isRealDate(+y, +m, +d) ? `${y}-${pad(m)}-${pad(d)}` : null;
    }
    return null;
}
/** Calendar-valid check — rejects 20261338 and 2026-02-31 rather than suggesting them. */
function isRealDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31)
        return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** The command's date-ish flag, if it declares one (`--date`, or keikka's `--pvm`). */
function dateFlagOf(spec) {
    const names = (spec?.flags ?? []).map((f) => f.name);
    return names.find((n) => n === "date" || n === "pvm") ?? null;
}
/** Positionals a command received beyond the ones it declares. */
export function excessPositionals(cmd) {
    const declared = cmd.registeredArguments?.length ?? 0;
    return (cmd.args ?? []).slice(declared).map(String);
}
/**
 * A command's spec-backed surface, resolved once: rendered path, matching spec
 * (if any), flag longs, and declared positionals. Both error-envelope builders
 * and the date-flag hint used to derive this triple independently.
 */
function commandSurface(cmd) {
    const command = commandPath(cmd);
    const spec = COMMAND_SPECS.find((s) => s.command === canonicalPath(command));
    return {
        command,
        spec,
        availableOptions: spec ? specOptionLongs(spec) : commanderOptionLongs(cmd),
        positionals: spec ? specPositionals(spec) : [],
    };
}
/**
 * `--date <normalized>` when one of `excess` is recognisably a date and this
 * command declares a date flag — otherwise null. Takes the tokens explicitly
 * (rather than re-deriving them) so the caller that already computed them and
 * the caller that hasn't share one implementation without two sources of truth.
 *
 * Used by the excess-arguments path AND the missing-required-flag path.
 * Commander reports a missing mandatory option BEFORE excess positionals, so a
 * caller who makes both mistakes at once (`ib message daily get 5 today`, with
 * --asiakas required) would otherwise be told only about the flag, and the date
 * hint would silently never fire — the same validation-ordering masking that
 * fb#309 hit with unknown options.
 */
export function dateFlagSuggestion(cmd, excess) {
    const dateFlag = dateFlagOf(commandSurface(cmd).spec);
    if (!dateFlag)
        return null;
    for (const token of excess) {
        const date = asDateSuggestion(token);
        if (date)
            return { suggestion: `--${dateFlag} ${date}`, token, date };
    }
    return null;
}
/**
 * Enriched "too many arguments" envelope (feedback #328).
 *
 * Commander's default says only what was rejected — "Expected 1 argument but
 * got 2: 52, 20260806" — never what was obviously meant. The captured instance
 * shows why that matters: the caller repeated the SAME shape on the next call
 * rather than reading the remedy off the error. When a surplus positional is
 * recognisably a date and the command declares a `--date`/`--pvm` flag, suggest
 * it directly, normalised to the documented format so a compact `YYYYMMDD`
 * (also wrong) is corrected in the same breath.
 *
 * Spec-driven, so it covers every `<id> + --date` command rather than being
 * special-cased to `vehicle timeline`.
 */
export function buildExcessArgumentsEnvelope(cmd, excess, parserDetail) {
    const { command, availableOptions, positionals } = commandSurface(cmd);
    const dated = dateFlagSuggestion(cmd, excess);
    const didYouMean = dated?.suggestion ?? null;
    const parts = [];
    if (dated) {
        parts.push(`Did you mean \`${dated.suggestion}\`? A date is passed as a FLAG here, not a positional` +
            (dated.token !== dated.date ? ` (and the documented format is YYYY-MM-DD)` : "") +
            ".");
    }
    else {
        // No date to latch onto — the other common cause is the shell splitting a
        // quoted value on its inner double-quotes (typical on Windows PowerShell).
        parts.push("Extra positional(s) were passed. On Windows PowerShell this also happens when a quoted flag value is split on its inner double-quotes — check whether one long value became several arguments.");
    }
    if (positionals.length) {
        parts.push(`This command takes positional argument(s): ${positionals.join(" ")}.`);
    }
    else {
        parts.push("This command takes no positional arguments.");
    }
    if (availableOptions.length)
        parts.push(`Accepted flags: ${availableOptions.join(", ")}.`);
    parts.push(`Run \`${command} --help\` for the full spec.`);
    return {
        success: false,
        error: parserDetail,
        code: "USAGE",
        statusCode: 0,
        command,
        excess,
        didYouMean,
        availableOptions,
        positionals,
        hint: parts.join(" "),
    };
}
/** Longest an echoed unknown-option token stays readable inside an error payload. */
const MAX_OPTION_ECHO = 80;
/**
 * Clamp the echoed token to something readable.
 *
 * Commander labels ANY dash-led argv element an "unknown option", including a
 * whole quoted prose block that merely STARTS with one. Filing a report whose
 * text opened with `--severity` therefore echoed ~3 KB of that report back
 * twice — once in `error`, once in `unknownOption` — burying the remedy in the
 * payload it was meant to fix (feedback #359).
 */
export function truncateOptionToken(token) {
    const flat = token.replace(/\s+/g, " ").trim();
    return flat.length > MAX_OPTION_ECHO ? `${flat.slice(0, MAX_OPTION_ECHO)}…` : flat;
}
/**
 * Lead the hint with "that was prose, not a flag" when the rejected token is
 * plainly a sentence.
 *
 * A real flag is a single dash-led word; a description that merely OPENS with a
 * flag name (`--severity means two different things in two commands…`) is not,
 * and any internal whitespace settles it. Worth special-casing because the two
 * commands that accept long prose are also the two whose prose is most likely
 * to quote a flag first: a bug report ABOUT `--severity` naturally begins with
 * `--severity` (feedback #359 — the report describing this hit it while being
 * filed). Without this the caller only sees a did-you-mean over flag names,
 * which is advice for a mistake they did not make.
 */
export function prosePrefixHint(token, availableOptions) {
    if (!/\s/.test(token.trim()))
        return [];
    if (!availableOptions.includes("--description")) {
        return ["That token contains whitespace, so it reads as prose rather than a flag — bind it to the flag it belongs to."];
    }
    const viaJson = availableOptions.includes("--from-json")
        ? " Or pass the whole payload via `--from-json <file|->`, which sidesteps argv quoting entirely."
        : "";
    return [
        `That token contains whitespace, so it reads as prose rather than a flag: if it is your description text, bind it explicitly with \`--description "<text>"\` instead of leaving it positional.${viaJson}`,
    ];
}
/**
 * Enriched "unknown option" error envelope — the flag analogue of
 * {@link buildUnknownCommandEnvelope}. When Commander rejects a guessed flag
 * (`ib customer search --search X`) the default USAGE envelope only echoes
 * "unknown option '--search'" with a generic hint — a dead end that doesn't say
 * what the command DOES accept (feedback #235/#236). This lists the command's
 * real positionals + flags, a fuzzy "did you mean" among its actual flags, the
 * sibling command(s) that DO accept the flag, and (when present) a curated
 * cross-command redirect. `cmd` is the command that threw (a leaf — options
 * belong to leaves); `unknownOption` is the bad flag verbatim incl. leading
 * dashes (e.g. `--search`).
 */
export function buildUnknownOptionEnvelope(cmd, unknownOption, tier = "developer") {
    const { command, spec, availableOptions, positionals } = commandSurface(cmd);
    const bare = unknownOption.replace(/^-+/, "");
    const guess = closestName(bare, availableOptions.map((o) => o.replace(/^-+/, "")));
    const didYouMean = guess ? `--${guess}` : null;
    const redirect = OPTION_REDIRECTS[`${command} ${unknownOption}`];
    // A curated redirect is hand-written for this exact command+flag, so it wins;
    // the derived sibling list is the general case behind it.
    const acceptedBy = redirect
        ? []
        : siblingsAcceptingOption(canonicalPath(command), unknownOption, tier);
    const domain = command.split(" ")[1]; // token after `ib`, e.g. customer
    const discover = domain
        ? `\`${command} --help\` or \`ib commands ${domain}\``
        : "`ib --help` or `ib commands`";
    const parts = [];
    if (redirect)
        parts.push(redirect);
    if (acceptedBy.length === 1) {
        parts.push(`\`${unknownOption}\` belongs to \`${acceptedBy[0]}\` — that sibling command owns this capability, not this one.`);
    }
    else if (acceptedBy.length > 1) {
        parts.push(`\`${unknownOption}\` belongs to a sibling command: ${acceptedBy.map((c) => `\`${c}\``).join(", ")}.`);
    }
    if (didYouMean)
        parts.push(`Did you mean \`${didYouMean}\`?`);
    if (positionals.length) {
        parts.push(`This command takes positional argument(s): ${positionals.join(" ")}.`);
    }
    parts.push(availableOptions.length
        ? `Accepted flags: ${availableOptions.join(", ")}.`
        : "This command takes no command-specific flags.");
    parts.push(`Run ${discover} for the full spec.`);
    // A leaf reached through a Commander `.alias()` reports its CANONICAL name
    // here, so `ib legal list --type X` answers "on `ib legal active`" — naming a
    // command the caller never typed, with nothing saying the two are one
    // (feedback #342). Name the other spellings so the identity is explicit.
    const aliasBridge = spec?.aliases?.length
        ? ` (also invocable as ${spec.aliases.map((a) => `\`${a}\``).join(", ")})`
        : "";
    return {
        success: false,
        error: `unknown option "${truncateOptionToken(unknownOption)}" on \`${command}\`${aliasBridge}`,
        code: "USAGE",
        statusCode: 0,
        command,
        unknownOption: truncateOptionToken(unknownOption),
        didYouMean,
        availableOptions,
        positionals,
        acceptedBy,
        hint: [...prosePrefixHint(unknownOption, availableOptions), ...parts].join(" "),
    };
}
//# sourceMappingURL=unknownCommand.js.map