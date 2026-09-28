import { COMMAND_SPECS } from "../reference/specs.js";
import { commandDomains, fullyHiddenDomains } from "../reference/commandsList.js";
import { createApiClient } from "../api/client.js";
import { usageEnvelopeResolves } from "./unknownCommand.js";
import packageJson from "../../package.json" with { type: "json" };
/** A slow backend must not stall an error render: answer nothing instead. */
const LOOKUP_TIMEOUT_MS = 1500;
/** Letters only (Finnish included), at least 3 — a typo'd flag or an id is not a word. */
const WORD = /^\p{L}{3,}$/u;
/** The lookup hook for a session, or undefined when there is no token. */
export function makeGlossaryLookup(auth) {
    if (!auth)
        return undefined;
    const client = createApiClient({ endpoint: auth.endpoint, token: auth.token, version: packageJson.version, quiet: true });
    return (term) => client.get(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
}
/**
 * The root domain the glossary relates `term` to, when that domain exists and
 * is visible at `tier` (a hint must not confirm a hidden domain exists).
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
        const domains = new Set(commandDomains(COMMAND_SPECS));
        const hidden = fullyHiddenDomains(tier);
        for (const { command } of hit.relatedCommands ?? []) {
            const domain = command.split(" ")[1];
            if (domain && domains.has(domain) && !hidden.has(domain)) {
                const via = hit.term.toLowerCase() === term.toLowerCase() ? "" : ` (as a synonym of \`${hit.term}\`)`;
                return { path: `ib ${domain}`, why: `the glossary relates \`${term}\`${via} to \`ib ${domain}\`` };
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
 * word-shaped, or the glossary has no visible domain for it.
 */
export async function withGlossaryRedirect(env, cmd, lookup, tier) {
    if (env.group !== "ib" || usageEnvelopeResolves(env) || !WORD.test(env.unknownCommand))
        return env;
    const match = await glossaryDomainFor(env.unknownCommand, lookup, tier);
    if (!match)
        return env;
    // Same copy-paste rendering as the offline layers: the caller's remaining args.
    const rest = (cmd.args ?? []).slice(1).map(String);
    const run = [match.path, ...rest].join(" ");
    return {
        ...env,
        availableElsewhere: [match.path],
        hint: `\`ib ${env.unknownCommand}\` does not exist, but \`${run}\` does — ${match.why}. ${env.hint}`,
    };
}
//# sourceMappingURL=glossaryRedirect.js.map