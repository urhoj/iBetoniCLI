import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { domainBlurb } from "./domain.js";
import { visibleSpecs, domainOf, hiddenDomainsAtTier } from "../tier.js";
/** Single source for the write classification used by `ib commands`. */
const isWriteSpec = (s) => s.mutates ?? !!s.writeFlags;
/** Unique, sorted set of command domains (the token after `ib`), derived from the specs. */
export function commandDomains(specs) {
    return [...new Set(specs.map((s) => domainOf(s.command)).filter(Boolean))].sort();
}
/**
 * Domains every leaf of which is hidden at `tier` (so the whole domain should
 * disappear from discovery — e.g. ai/schema/changelog at "standard"). Used to
 * tier-filter the ROOT `ib --help` command listing and the unknown-domain error
 * suggestion list, mirroring how `buildDomainIndex` drops zero-visible-leaf
 * domains. Empty for "developer".
 */
export function fullyHiddenDomains(tier) {
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
export function assertKnownDomain(specs, domain, tier = "developer") {
    const valid = commandDomains(specs); // FULL set — validation
    if (!valid.includes(domain)) {
        const suggest = commandDomains(visibleSpecs(specs, tier)); // visible-only — suggestion
        throw new CliError(`unknown domain: ${domain}. Valid: ${suggest.join(", ")}`, 0, null, 4);
    }
}
/**
 * Filter {@link CommandSpec}s down to the compact {@link CommandSummary} shape.
 * `--mutations` and `--reads` are mutually exclusive (a command cannot be both);
 * passing both is a validation error (exit 4). `permission` matches a
 * case-insensitive substring against each spec's `permissions` entries.
 */
export function filterCommandSpecs(specs, filter, tier = "developer") {
    if (filter.mutations && filter.reads) {
        throw new CliError("--mutations and --reads are mutually exclusive", 0, null, 4);
    }
    // Validate against the FULL specs so an unknown domain still exit-4s, while a
    // hidden-but-valid domain (e.g. `schema` at standard) yields an empty list.
    if (filter.domain)
        assertKnownDomain(specs, filter.domain, tier);
    const needle = filter.permission?.toLowerCase();
    return visibleSpecs(specs, tier)
        .filter((s) => {
        if (filter.domain && domainOf(s.command) !== filter.domain)
            return false;
        const mutates = isWriteSpec(s);
        if (filter.mutations && !mutates)
            return false;
        if (filter.reads && mutates)
            return false;
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
export function buildCommandsList(filter, tier = "developer") {
    const items = filterCommandSpecs(COMMAND_SPECS, filter, tier);
    return { items, nextCursor: null, count: items.length };
}
/**
 * Bare `ib commands` — a ~5 KB domain INDEX instead of the full flat list
 * (~43 KB at 149 leaves and growing). Progressive-discovery entry point:
 * index → `ib commands <domain>` → `ib <command> --help`. The flat list moved
 * behind `--all` (BREAKING, 2026-06-10). Blurbs come from the offline
 * {@link DOMAIN_BLURBS} map (via {@link domainBlurb}), so domains without an
 * entry get null.
 */
export function buildDomainIndex(specs = COMMAND_SPECS, tier = "developer") {
    const visible = visibleSpecs(specs, tier);
    const items = commandDomains(visible)
        .map((domain) => {
        const inDomain = visible.filter((s) => domainOf(s.command) === domain);
        return {
            domain,
            count: inDomain.length,
            description: domainBlurb(domain),
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
//# sourceMappingURL=commandsList.js.map