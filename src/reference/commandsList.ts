/**
 * `ib commands` — a filtered, offline view over the {@link COMMAND_SPECS}
 * catalogue.
 *
 * `ib reference dump` emits the entire surface (every flag, error, example) for
 * one-shot ingestion; `ib commands` is the lightweight discovery counterpart —
 * "which commands write?", "which are read-only?", "which need permission X?" —
 * returning just `{ command, description, permissions, isWrite }` per match.
 * Pure and offline (no auth, no network); the source of truth is the same
 * `COMMAND_SPECS` so this never drifts from `--help` / `reference dump`.
 */
import type { CommandSpec } from "../output/help.js";
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { GLOSSARY } from "./domain.js";
import { type CallerTier, visibleSpecs, domainOf, hiddenDomainsAtTier } from "../tier.js";

/** Single source for the write classification used by `ib commands`. */
const isWriteSpec = (s: CommandSpec): boolean => s.mutates ?? !!s.writeFlags;

/** Compact per-command summary surfaced by `ib commands`. */
export interface CommandSummary {
  command: string;
  description: string;
  permissions: string[];
  /**
   * True when the command mutates (writes) data: `spec.mutates ?? !!spec.writeFlags`.
   * Named `isWrite` (not `writeFlags`) because the spec field `writeFlags` means
   * "renders the standard write-safety block" — a different thing.
   */
  isWrite: boolean;
}

/** Filter inputs for {@link filterCommandSpecs}. */
export interface CommandsListFilter {
  /** Keep only mutating commands (mutates:true, or writeFlags:true when mutates is absent). */
  mutations?: boolean;
  /** Keep only non-mutating (read-only) commands. */
  reads?: boolean;
  /** Keep only commands whose permission strings contain this substring. */
  permission?: string;
  /** Keep only commands in this domain (the token after `ib`). Unknown domain → exit-4 CliError. */
  domain?: string;
}

/** Unique, sorted set of command domains (the token after `ib`), derived from the specs. */
export function commandDomains(specs: CommandSpec[]): string[] {
  return [...new Set(specs.map((s) => domainOf(s.command)).filter(Boolean))].sort();
}

/**
 * Domains every leaf of which is hidden at `tier` (so the whole domain should
 * disappear from discovery — e.g. ai/schema/changelog at "standard"). Used to
 * tier-filter the ROOT `ib --help` command listing and the unknown-domain error
 * suggestion list, mirroring how `buildDomainIndex` drops zero-visible-leaf
 * domains. Empty for "developer".
 */
export function fullyHiddenDomains(tier: CallerTier): Set<string> {
  return hiddenDomainsAtTier(COMMAND_SPECS, tier);
}

/**
 * Throw an exit-4 CliError when `domain` is not a known command domain.
 * Single validation point shared by `ib commands` and `ib reference dump` so
 * the message and exit code can never diverge. Validation uses the FULL domain
 * set (so a hidden-but-valid domain like `schema` at standard does NOT error —
 * it yields an empty list); `tier` narrows ONLY the "Valid:" suggestion list so
 * the error never leaks a developer-only domain to a standard caller.
 */
export function assertKnownDomain(
  specs: CommandSpec[],
  domain: string,
  tier: CallerTier = "developer"
): void {
  const valid = commandDomains(specs); // FULL set — validation
  if (!valid.includes(domain)) {
    const suggest = commandDomains(visibleSpecs(specs, tier)); // visible-only — suggestion
    throw new CliError(
      `unknown domain: ${domain}. Valid: ${suggest.join(", ")}`,
      0,
      null,
      4
    );
  }
}

/** List-envelope shape (matches the universal `{ items, nextCursor, count }`). */
export interface CommandsListEnvelope {
  /** Reserved for shape compatibility; `buildDomainIndex` owns discovery hints. */
  hint?: string;
  items: CommandSummary[];
  nextCursor: null;
  count: number;
}

/**
 * Filter {@link CommandSpec}s down to the compact {@link CommandSummary} shape.
 * `--mutations` and `--reads` are mutually exclusive (a command cannot be both);
 * passing both is a validation error (exit 4). `permission` matches a
 * case-insensitive substring against each spec's `permissions` entries.
 */
export function filterCommandSpecs(
  specs: CommandSpec[],
  filter: CommandsListFilter,
  tier: CallerTier = "developer"
): CommandSummary[] {
  if (filter.mutations && filter.reads) {
    throw new CliError(
      "--mutations and --reads are mutually exclusive",
      0,
      null,
      4
    );
  }
  // Validate against the FULL specs so an unknown domain still exit-4s, while a
  // hidden-but-valid domain (e.g. `schema` at standard) yields an empty list.
  if (filter.domain) assertKnownDomain(specs, filter.domain, tier);
  const needle = filter.permission?.toLowerCase();
  return visibleSpecs(specs, tier)
    .filter((s) => {
      if (filter.domain && domainOf(s.command) !== filter.domain) return false;
      const mutates = isWriteSpec(s);
      if (filter.mutations && !mutates) return false;
      if (filter.reads && mutates) return false;
      if (needle && !s.permissions?.some((p) => p.toLowerCase().includes(needle))) {
        return false;
      }
      return true;
    })
    .map((s) => ({
      command: s.command,
      description: s.description,
      permissions: s.permissions ?? [],
      isWrite: isWriteSpec(s),
    }));
}

/**
 * Build the `ib commands` envelope from the live {@link COMMAND_SPECS}. Pure —
 * callers (`program.ts`) handle stdout via `writeJson`.
 */
export function buildCommandsList(
  filter: CommandsListFilter,
  tier: CallerTier = "developer"
): CommandsListEnvelope {
  const items = filterCommandSpecs(COMMAND_SPECS, filter, tier);
  return { items, nextCursor: null, count: items.length };
}

/** One row of the `ib commands` (no-args) domain index. */
export interface DomainIndexEntry {
  /** The token after `ib` (e.g. `keikka`). */
  domain: string;
  /** Number of leaf commands in the domain. */
  count: number;
  /** Glossary blurb when a GLOSSARY term matches the domain name, else null. */
  description: string | null;
  /** Leaf command paths relative to `ib` (directly runnable, e.g. "keikka list"). */
  commands: string[];
}

/** Envelope for the domain index; `hint` is the FIRST key so it's read before the rows. */
export interface DomainIndexEnvelope {
  hint: string;
  items: DomainIndexEntry[];
  nextCursor: null;
  count: number;
}

/**
 * Bare `ib commands` — a ~5 KB domain INDEX instead of the full flat list
 * (~43 KB at 149 leaves and growing). Progressive-discovery entry point:
 * index → `ib commands <domain>` → `ib <command> --help`. The flat list moved
 * behind `--all` (BREAKING, 2026-06-10). Blurbs reuse the GLOSSARY (same
 * source as group help), so domains without a glossary term get null.
 */
/**
 * Pick the GLOSSARY blurb for a domain. Prefer a WHOLE-WORD match so a domain
 * never inherits a blurb where its name is merely a substring of another term
 * (the "ai" ⊂ "sij**ai**nti" collision — `ai` must get the `ai / conversation`
 * entry, not sijainti's). Fall back to a loose substring match for compound
 * terms with no word boundary before the domain (e.g. `jerry` ⊂ "BetoniJerry").
 * Returns null when no glossary term mentions the domain. Domain names are
 * command tokens (lowercase letters), so they are regex-safe.
 */
function glossaryBlurbForDomain(domain: string): string | null {
  const wholeWord = new RegExp(`\\b${domain}\\b`, "i");
  return (
    GLOSSARY.find((g) => wholeWord.test(g.term))?.definition ??
    GLOSSARY.find((g) => g.term.toLowerCase().includes(domain))?.definition ??
    null
  );
}

export function buildDomainIndex(
  specs: CommandSpec[] = COMMAND_SPECS,
  tier: CallerTier = "developer"
): DomainIndexEnvelope {
  const visible = visibleSpecs(specs, tier);
  const items = commandDomains(visible)
    .map((domain) => {
      const inDomain = visible.filter(
        (s) => domainOf(s.command) === domain
      );
      return {
        domain,
        count: inDomain.length,
        description: glossaryBlurbForDomain(domain),
        commands: inDomain.map((s) => s.command.replace(/^ib /, "")),
      };
    })
    .filter((d) => d.count > 0);
  return {
    hint: "domain index — one domain's commands: `ib commands <domain>` · full flat list: `ib commands --all` · one command's spec: `ib <command> --help`",
    items,
    nextCursor: null,
    count: items.length,
  };
}
