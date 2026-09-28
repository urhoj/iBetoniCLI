/**
 * Glossary fallback for an unknown ROOT command (fb#2044).
 *
 * `ib asiakas get 8` dead-ended with `didYouMean: null` although the glossary
 * maps `asiakas` to `ib customer`: every other redirect layer in
 * unknownCommand.ts is offline and spelling-based, and a Finnish domain word
 * shares no spelling with its English command. Rather than curate one hidden
 * alias per word (`tyomaa` → `worksite` in domains.ts is the only one), the
 * root asks the glossary — the single source of truth for that vocabulary.
 *
 * Best-effort and last: consulted only when every offline layer stayed silent,
 * only at the root, only for a word-shaped token, and any failure (no session,
 * offline, 404, slow backend) answers nothing. A glossary miss is recorded
 * server-side for the groomer, same as `ib glossary lookup` and `ib help <term>`.
 */
import type { Command } from "commander";
import { COMMAND_SPECS } from "../reference/specs.js";
import { commandDomains, fullyHiddenDomains } from "../reference/commandsList.js";
import { createApiClient } from "../api/client.js";
import type { CallerTier } from "../tier.js";
import { usageEnvelopeResolves, type SiblingGroupMatch, type UnknownCommandEnvelope } from "./unknownCommand.js";
import packageJson from "../../package.json" with { type: "json" };

export interface GlossaryHit {
  term: string;
  relatedCommands?: Array<{ command: string }>;
}

/** Resolves a term to its glossary entry, or null on a miss. May throw. */
export type GlossaryLookup = (term: string) => Promise<GlossaryHit | null>;

/** A slow backend must not stall an error render: answer nothing instead. */
const LOOKUP_TIMEOUT_MS = 1500;

/** Letters only (Finnish included), at least 3 — a typo'd flag or an id is not a word. */
const WORD = /^\p{L}{3,}$/u;

/** The lookup hook for a session, or undefined when there is no token. */
export function makeGlossaryLookup(auth: { token: string; endpoint: string } | null): GlossaryLookup | undefined {
  if (!auth) return undefined;
  const client = createApiClient({ endpoint: auth.endpoint, token: auth.token, version: packageJson.version, quiet: true });
  return (term) => client.get<GlossaryHit>(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
}

/**
 * The root domain the glossary relates `term` to, when that domain exists and
 * is visible at `tier` (a hint must not confirm a hidden domain exists).
 */
export async function glossaryDomainFor(
  term: string,
  lookup: GlossaryLookup,
  tier: CallerTier
): Promise<SiblingGroupMatch | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
    });
    const hit = await Promise.race([lookup(term), timeout]);
    if (!hit) return null;
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
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill a dead-end ROOT envelope from the glossary. Returns the envelope
 * unchanged when it already resolves, is not at the root, the token is not
 * word-shaped, or the glossary has no visible domain for it.
 */
export async function withGlossaryRedirect(
  env: UnknownCommandEnvelope,
  cmd: Command,
  lookup: GlossaryLookup,
  tier: CallerTier
): Promise<UnknownCommandEnvelope> {
  if (env.group !== "ib" || usageEnvelopeResolves(env) || !WORD.test(env.unknownCommand)) return env;
  const match = await glossaryDomainFor(env.unknownCommand, lookup, tier);
  if (!match) return env;
  // Same copy-paste rendering as the offline layers: the caller's remaining args.
  const rest = (cmd.args ?? []).slice(1).map(String);
  const run = [match.path, ...rest].join(" ");
  return {
    ...env,
    availableElsewhere: [match.path],
    hint: `\`ib ${env.unknownCommand}\` does not exist, but \`${run}\` does — ${match.why}. ${env.hint}`,
  };
}
