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
import type { CommandArg, CommandFlag, CommandSpec } from "../output/help.js";
import { firstSentence } from "../output/help.js";
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { domainBlurb } from "./domain.js";
import {
  type CallerTier,
  visibleSpecs,
  domainOf,
  hiddenDomainsAtTier,
  getCallerTier,
} from "../tier.js";
import { listEnvelope } from "../api/envelopes.js";

/**
 * Single source for the write classification used by `ib commands` — and by
 * `buildUnknownOptionEnvelope`, which needs the same "does this command mutate?"
 * answer to phrase a rejected write-safety flag (fb#646). Exported so that
 * claim stays true: a second inline copy of `mutates ?? !!writeFlags` is exactly
 * how it silently stopped being single.
 */
export const isWriteSpec = (s: CommandSpec): boolean => s.mutates ?? !!s.writeFlags;

function commandRelativePath(command: string): string {
  return command.replace(/^ib\s+/, "");
}

function nestedSubgroupPrefixes(specs: CommandSpec[]): Map<string, Set<string>> {
  const bySubgroup = new Map<string, Set<string>>();
  for (const spec of specs) {
    const [domain, subgroup, leaf] = commandRelativePath(spec.command).split(/\s+/);
    if (!domain || !subgroup || !leaf) continue;
    const prefixes = bySubgroup.get(subgroup) ?? new Set<string>();
    prefixes.add(`${domain} ${subgroup}`);
    bySubgroup.set(subgroup, prefixes);
  }
  return bySubgroup;
}

/**
 * Resolve a discovery token (the arg to `ib commands <x>` / `ib reference dump
 * <x>`) into a spec predicate. Accepts a top-level domain (the token after `ib`)
 * OR a bare nested-subgroup name that lives under exactly one domain (e.g.
 * `changelog` → `dev changelog`) — the same aliases the executable command
 * surface accepts as hidden runtime paths after the 2026-06-30 `ib dev`
 * re-homing. Unknown token → exit-4 `CliError` (via {@link assertKnownDomain},
 * tier-filtered suggestions). Shared by `ib commands` ({@link filterCommandSpecs})
 * and `ib reference dump` (`buildReference`) so the two discovery surfaces
 * resolve tokens identically and can never drift (feedback #137).
 */
export function specMatcherForToken(
  specs: CommandSpec[],
  token: string,
  tier: CallerTier = getCallerTier()
): (spec: CommandSpec) => boolean {
  if (token && !commandDomains(specs).includes(token)) {
    const prefixes = nestedSubgroupPrefixes(specs).get(token);
    if (prefixes?.size === 1) {
      const prefix = [...prefixes][0];
      return (s) => {
        const rel = commandRelativePath(s.command);
        return rel === prefix || rel.startsWith(`${prefix} `);
      };
    }
    assertKnownDomain(specs, token, tier); // unknown token → exit-4 throw
  }
  return (s) => domainOf(s.command) === token;
}

/** `<name:type>` (required) / `[name:type]` (optional) — mirrors formatHelp's USAGE rule
 *  (`required === false` is optional; absent means required). */
function argSignature(a: CommandArg): string {
  return a.required === false ? `[${a.name}:${a.type}]` : `<${a.name}:${a.type}>`;
}

/** An enum short enough to inline beats a bare type name; longer lists stay
 *  `<string>`. 32 deliberately covers `feature|improvement|bugfix|docs` (31). */
const ENUM_SIG_MAX = 32;

/** Compact per-flag call shape: `--name` (boolean), `--name <a|b|c>` (short enum),
 *  `--name <type>`; suffix `!` = required, `*` = one of a required group. The
 *  notation is spelled out in the signatures envelope's `hint`. */
function flagSignature(f: CommandFlag): string {
  let sig = `--${f.name}`;
  if (f.type !== "boolean") {
    const joined = f.allowed?.join("|");
    sig += joined && joined.length <= ENUM_SIG_MAX ? ` <${joined}>` : ` <${f.type}>`;
  }
  if (f.required) sig += "!";
  else if (f.requiredGroup) sig += "*";
  return sig;
}

/** Compact per-command summary surfaced by `ib commands`. */
export interface CommandSummary {
  command: string;
  /** FIRST SENTENCE of the spec description (fb#382 — the flat list is a
   *  discovery skim; the full text is one `--help` away and in `reference dump`).
   *  Mirrors how group help renders its leaf table. */
  description: string;
  permissions: string[];
  /**
   * True when the command mutates (writes) data: `spec.mutates ?? !!spec.writeFlags`.
   * Named `isWrite` (not `writeFlags`) because the spec field `writeFlags` means
   * "renders the standard write-safety block" — a different thing.
   */
  isWrite: boolean;
  /**
   * Present on writes with a declared `--dry-run` resolution kind: `"client"`
   * never issues the write (safe under --read-only); `"server"`/absent sends
   * `X-Dry-Run` and trusts the deployed backend guard.
   */
  dryRunKind?: "server" | "client";
  /** `--signatures` only: positional call shapes (`<name:type>` / `[name:type]`). Omitted when the command takes none. */
  args?: string[];
  /** `--signatures` only: per-flag call shapes from {@link flagSignature}. Omitted when the command has no flags. */
  flags?: string[];
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
  /**
   * Intent-first keyword search (fb#781): keep only commands whose PATH,
   * description, or `--`-prefixed flag names contain this case-insensitive
   * substring. Offline (pure catalogue scan) — the zero-network twin of
   * `ib glossary lookup`, for when the caller knows the concept but not the
   * domain (cross-domain verbs: driver → vehicle, geocode → sijainti).
   * Empty/whitespace → exit-4 CliError (PowerShell drops a bare "" argument
   * and would silently swallow the next flag as the needle).
   */
  find?: string;
  /**
   * Signatures tier (fb#779): add each command's compact call shape — `args`
   * and `flags` signature strings — to the summary rows. The middle rung
   * between `ib commands --all` (names only) and `ib reference dump` (full
   * specs): everything needed to CONSTRUCT most invocations at ~⅕ of the
   * dump's tokens. The envelope's `hint` explains the notation.
   */
  signatures?: boolean;
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
  tier: CallerTier = getCallerTier()
): void {
  const valid = commandDomains(specs); // FULL set — validation
  if (!valid.includes(domain)) {
    const visible = visibleSpecs(specs, tier); // visible-only — never leak a hidden subtree
    const suggest = commandDomains(visible);
    // Did-you-mean when the unknown token is really a nested subgroup addressed
    // by its bare leaf name (e.g. `changelog` → `dev changelog`). `ib commands
    // <sub>` already resolves these in specMatcherForToken; this covers the
    // callers that hit the validator directly (`ib reference dump <sub>`, and
    // subgroups that live under more than one domain). Tier-filtered so a
    // developer-only subgroup is never suggested to a standard caller.
    const subgroups = nestedSubgroupPrefixes(visible).get(domain);
    const didYouMean =
      subgroups && subgroups.size
        ? ` Did you mean: ${[...subgroups].map((p) => `\`${p}\``).join(" or ")}?`
        : "";
    throw new CliError(
      `unknown domain: ${domain}.${didYouMean} Valid: ${suggest.join(", ")}`,
      0,
      null,
      4
    );
  }
}

/** List-envelope shape (matches the universal `{ items, nextCursor, count }`);
 *  `hint` (first key, `--signatures` only) explains the signature notation. */
export interface CommandsListEnvelope {
  hint?: string;
  items: CommandSummary[];
  nextCursor: string | null;
  count: number;
}

/** Leading hint on the `--signatures` envelope — read before the rows (same
 *  pattern as {@link buildDomainIndex}). Names the write-safety trio ONCE
 *  instead of repeating three flag signatures on ~125 write commands. */
const SIGNATURES_HINT =
  "signature notation: <x:t> required arg · [x:t] optional arg · --f <t> flag (booleans take no value) · <a|b> allowed values · ! required · * one of a required group. isWrite commands also accept --dry-run/--idempotency-key/--reason (`ib help write-safety`). Full flag semantics: `ib <command> --help`.";

/**
 * Filter {@link CommandSpec}s down to the compact {@link CommandSummary} shape.
 * `--mutations` and `--reads` are mutually exclusive (a command cannot be both);
 * passing both is a validation error (exit 4). `permission` matches a
 * case-insensitive substring against each spec's `permissions` entries.
 */
export function filterCommandSpecs(
  specs: CommandSpec[],
  filter: CommandsListFilter,
  tier: CallerTier = getCallerTier()
): CommandSummary[] {
  if (filter.mutations && filter.reads) {
    throw new CliError(
      "--mutations and --reads are mutually exclusive",
      0,
      null,
      4
    );
  }
  if (filter.find !== undefined && filter.find.trim() === "") {
    throw new CliError("--find requires non-empty search text", 0, null, 4);
  }
  // Resolve against the FULL specs so a hidden-but-valid domain/subgroup at
  // standard tier yields an empty list instead of leaking developer-only names.
  // The domain/subgroup matcher is shared with `ib reference dump` so the two
  // surfaces resolve a token identically (feedback #137).
  const matchesToken = filter.domain
    ? specMatcherForToken(specs, filter.domain, tier)
    : () => true;
  const needle = filter.permission?.toLowerCase();
  const findNeedle = filter.find?.trim().toLowerCase();
  return visibleSpecs(specs, tier)
    .filter((s) => {
      if (!matchesToken(s)) return false;
      const mutates = isWriteSpec(s);
      if (filter.mutations && !mutates) return false;
      if (filter.reads && mutates) return false;
      if (needle && !s.permissions?.some((p) => p.toLowerCase().includes(needle))) {
        return false;
      }
      if (
        findNeedle &&
        ![s.command, s.description, ...s.flags.map((f) => `--${f.name}`)]
          .join("\n")
          .toLowerCase()
          .includes(findNeedle)
      ) {
        return false;
      }
      return true;
    })
    .map((s) => ({
      command: s.command,
      description: firstSentence(s.description),
      permissions: s.permissions ?? [],
      isWrite: isWriteSpec(s),
      ...(s.dryRunKind ? { dryRunKind: s.dryRunKind } : {}),
      ...(filter.signatures && s.args?.length
        ? { args: s.args.map(argSignature) }
        : {}),
      ...(filter.signatures && s.flags.length
        ? { flags: s.flags.map(flagSignature) }
        : {}),
    }));
}

/**
 * Build the `ib commands` envelope from the live {@link COMMAND_SPECS}. Pure —
 * callers (`program.ts`) handle stdout via `writeJson`.
 */
export function buildCommandsList(
  filter: CommandsListFilter,
  tier: CallerTier = getCallerTier()
): CommandsListEnvelope {
  const envelope = listEnvelope(filterCommandSpecs(COMMAND_SPECS, filter, tier));
  return filter.signatures ? { hint: SIGNATURES_HINT, ...envelope } : envelope;
}

/** One row of the `ib commands` (no-args) domain index. */
export interface DomainIndexEntry {
  /** The token after `ib` (e.g. `keikka`). */
  domain: string;
  /** Number of leaf commands in the domain. */
  count: number;
  /** Offline domain blurb from {@link DOMAIN_BLURBS}; null when the domain has no entry. */
  description: string | null;
  /** Leaf command paths relative to `ib` (directly runnable, e.g. "keikka list").
   *  Capped at {@link INDEX_COMMANDS_CAP} per domain (fb#382) — `more` carries
   *  the count of paths not shown; `ib commands <domain>` lists them all. */
  commands: string[];
  /** Number of additional leaf paths not shown in `commands` (absent when none). */
  more?: number;
}

/** Max leaf paths a domain row lists in the bare index — enough to show the
 *  domain's shape without the big domains (dev 44, jerry 39, message 33)
 *  tripling the size of every fresh agent's FIRST discovery call (fb#382). */
const INDEX_COMMANDS_CAP = 8;

/** Envelope for the domain index; `hint` is the FIRST key so it's read before the rows. */
export interface DomainIndexEnvelope {
  hint: string;
  items: DomainIndexEntry[];
  nextCursor: string | null;
  count: number;
}

/**
 * Bare `ib commands` — a ~5 KB domain INDEX instead of the full flat list
 * (~43 KB at 149 leaves and growing). Progressive-discovery entry point:
 * index → `ib commands <domain>` → `ib <command> --help`. The flat list moved
 * behind `--all` (BREAKING, 2026-06-10). Blurbs come from the offline
 * {@link DOMAIN_BLURBS} map (via {@link domainBlurb}), so domains without an
 * entry get null.
 */
export function buildDomainIndex(
  specs: CommandSpec[] = COMMAND_SPECS,
  tier: CallerTier = getCallerTier()
): DomainIndexEnvelope {
  // One grouping pass: the per-domain `visible.filter(...)` re-scanned the whole
  // visible catalogue once per domain (~35 × 311), on top of a separate pass to
  // collect the domain names. Map keys are inserted in catalogue order and
  // sorted here, matching `commandDomains`; a grouped domain always has ≥ 1 leaf,
  // so the old `count > 0` filter is subsumed.
  const byDomain = new Map<string, CommandSpec[]>();
  for (const s of visibleSpecs(specs, tier)) {
    const domain = domainOf(s.command);
    if (!domain) continue;
    const group = byDomain.get(domain);
    if (group) group.push(s);
    else byDomain.set(domain, [s]);
  }
  const items = [...byDomain.keys()].sort().map((domain) => {
    const inDomain = byDomain.get(domain)!;
    const paths = inDomain.map((s) => s.command.replace(/^ib /, ""));
    const shown = paths.slice(0, INDEX_COMMANDS_CAP);
    return {
      domain,
      count: inDomain.length,
      description: domainBlurb(domain),
      commands: shown,
      ...(paths.length > shown.length ? { more: paths.length - shown.length } : {}),
    };
  });
  return {
    hint: "domain index — one domain's commands: `ib commands <domain>` · full flat list: `ib commands --all` · one command's spec: `ib <command> --help`. A row's `more: N` = N further paths not shown here.",
    ...listEnvelope(items),
  };
}
