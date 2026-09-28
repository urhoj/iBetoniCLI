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
import { canonicalPath } from "../reference/aliasPaths.js";
import { isHiddenAtTier, type CallerTier } from "../tier.js";
import type { ApiClient } from "../api/client.js";
import { usageEnvelopeResolves, type SiblingGroupMatch, type UnknownCommandEnvelope } from "./unknownCommand.js";

export interface GlossaryHit {
  term: string;
  relatedCommands?: Array<{ command: string }>;
}

/** Resolves a term to its glossary entry; throws on a miss (404) or any failure. */
export type GlossaryLookup = (term: string) => Promise<GlossaryHit | null>;

/** A slow backend must not stall an error render: stop waiting and answer nothing (the request is not aborted). */
const LOOKUP_TIMEOUT_MS = 1500;

/** Letters only (Finnish included), at least 3 — a typo'd flag or an id is not a word. */
const WORD = /^\p{L}{3,}$/u;

/**
 * The lookup over the invocation's own client factory (buildProgram's
 * `getClient`), so it acts with the same endpoint, session and embedded
 * caller as any command — never a token minted for another endpoint (fb#2058).
 */
export function glossaryLookupVia(getClient: () => Promise<ApiClient>): GlossaryLookup {
  return async (term) => (await getClient()).get<GlossaryHit>(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
}

/** Is `path` a command, or a group holding one, that is visible at `tier`? */
function visibleUnder(path: string, tier: CallerTier): boolean {
  return COMMAND_SPECS.some((s) => (s.command === path || s.command.startsWith(`${path} `)) && !isHiddenAtTier(s, tier));
}

/**
 * The command GROUP the glossary relates `term` to, when it is visible at
 * `tier` (a hint must not confirm a hidden command exists). A related LEAF
 * (`ib dev feedback create`) yields its immediate parent group, since the
 * caller's own verb belongs there; the root `ib` is never suggested (a depth-2
 * leaf's parent is the root).
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
    for (const { command } of hit.relatedCommands ?? []) {
      const path = canonicalPath(command);
      const group = COMMAND_SPECS.some((s) => s.command === path) ? path.slice(0, path.lastIndexOf(" ")) : path;
      if (group.split(" ").length >= 2 && visibleUnder(group, tier)) {
        const via = hit.term.toLowerCase() === term.toLowerCase() ? "" : ` (as a synonym of \`${hit.term}\`)`;
        return { path: group, why: `the glossary relates \`${term}\`${via} to \`${group}\`` };
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
 * word-shaped, or the glossary has no visible group for it.
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
  // Claim the caller's own command exists only when the group owns their verb;
  // otherwise point at the group's help rather than invent a path.
  const rest = (cmd.args ?? []).slice(1).map(String);
  const verb = rest.find((t) => !t.startsWith("-"));
  const answer =
    verb === undefined || visibleUnder(`${match.path} ${verb}`, tier)
      ? `but \`${[match.path, ...rest].join(" ")}\` does — ${match.why}`
      : `but ${match.why}; run \`${match.path} --help\` for its commands`;
  return {
    ...env,
    availableElsewhere: [match.path],
    hint: `\`ib ${env.unknownCommand}\` does not exist, ${answer}. ${env.hint}`,
  };
}
