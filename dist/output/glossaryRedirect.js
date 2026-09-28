import { COMMAND_SPECS } from "../reference/specs.js";
import { canonicalPath } from "../reference/aliasPaths.js";
import { isHiddenAtTier } from "../tier.js";
import { usageEnvelopeResolves } from "./unknownCommand.js";
/** A slow backend must not stall an error render: stop waiting and answer nothing (the request is not aborted). */
const LOOKUP_TIMEOUT_MS = 1500;
/** Letters only (Finnish included), at least 3 — a typo'd flag or an id is not a word. */
const WORD = /^\p{L}{3,}$/u;
/**
 * The lookup over the invocation's own client factory (buildProgram's
 * `getClient`), so it acts with the same endpoint, session and embedded
 * caller as any command — never a token minted for another endpoint (fb#2058).
 */
export function glossaryLookupVia(getClient) {
    return async (term) => (await getClient()).get(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
}
/** Is `path` a command, or a group holding one, that is visible at `tier`? */
function visibleUnder(path, tier) {
    return COMMAND_SPECS.some((s) => (s.command === path || s.command.startsWith(`${path} `)) && !isHiddenAtTier(s, tier));
}
/**
 * The command GROUP the glossary relates `term` to, when it is visible at
 * `tier` (a hint must not confirm a hidden command exists). A related LEAF
 * (`ib dev feedback create`) yields its immediate parent group, since the
 * caller's own verb belongs there; the root `ib` is never suggested (a depth-2
 * leaf's parent is the root).
 */
export async function glossaryDomainFor(term, lookup, tier) {
    let timer;
    try {
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
        });
        const hit = await Promise.race([lookup(term), timeout]);
        if (!hit)
            return null;
        for (const { command } of hit.relatedCommands ?? []) {
            const path = canonicalPath(command);
            const group = COMMAND_SPECS.some((s) => s.command === path) ? path.slice(0, path.lastIndexOf(" ")) : path;
            if (group.split(" ").length >= 2 && visibleUnder(group, tier)) {
                const via = hit.term.toLowerCase() === term.toLowerCase() ? "" : ` (as a synonym of \`${hit.term}\`)`;
                return { path: group, why: `the glossary relates \`${term}\`${via} to \`${group}\`` };
            }
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Fill a dead-end ROOT envelope from the glossary. Returns the envelope
 * unchanged when it already resolves, is not at the root, the token is not
 * word-shaped, or the glossary has no visible group for it.
 */
export async function withGlossaryRedirect(env, cmd, lookup, tier) {
    if (env.group !== "ib" || usageEnvelopeResolves(env) || !WORD.test(env.unknownCommand))
        return env;
    const match = await glossaryDomainFor(env.unknownCommand, lookup, tier);
    if (!match)
        return env;
    // Claim the caller's own command exists only when the group owns their verb;
    // otherwise point at the group's help rather than invent a path.
    const rest = (cmd.args ?? []).slice(1).map(String);
    const verb = rest.find((t) => !t.startsWith("-"));
    const answer = verb === undefined || visibleUnder(`${match.path} ${verb}`, tier)
        ? `but \`${[match.path, ...rest].join(" ")}\` does — ${match.why}`
        : `but ${match.why}; run \`${match.path} --help\` for its commands`;
    return {
        ...env,
        availableElsewhere: [match.path],
        hint: `\`ib ${env.unknownCommand}\` does not exist, ${answer}. ${env.hint}`,
    };
}
//# sourceMappingURL=glossaryRedirect.js.map