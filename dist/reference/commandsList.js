import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
/** Unique, sorted set of command domains (the token after `ib`), derived from the specs. */
export function commandDomains(specs) {
    return [...new Set(specs.map((s) => s.command.split(" ")[1]).filter(Boolean))].sort();
}
/**
 * Throw an exit-4 CliError when `domain` is not a known command domain.
 * Single validation point shared by `ib commands` and `ib reference dump` so
 * the message and exit code can never diverge.
 */
export function assertKnownDomain(specs, domain) {
    const valid = commandDomains(specs);
    if (!valid.includes(domain)) {
        throw new CliError(`unknown domain: ${domain}. Valid: ${valid.join(", ")}`, 0, null, 4);
    }
}
/**
 * Filter {@link CommandSpec}s down to the compact {@link CommandSummary} shape.
 * `--mutations` and `--reads` are mutually exclusive (a command cannot be both);
 * passing both is a validation error (exit 4). `permission` matches a
 * case-insensitive substring against each spec's `permissions` entries.
 */
export function filterCommandSpecs(specs, filter) {
    if (filter.mutations && filter.reads) {
        throw new CliError("--mutations and --reads are mutually exclusive", 0, null, 4);
    }
    if (filter.domain)
        assertKnownDomain(specs, filter.domain);
    const needle = filter.permission?.toLowerCase();
    return specs
        .filter((s) => {
        if (filter.domain && s.command.split(" ")[1] !== filter.domain)
            return false;
        const mutates = s.mutates ?? !!s.writeFlags;
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
        isWrite: s.mutates ?? !!s.writeFlags,
    }));
}
/**
 * Build the `ib commands` envelope from the live {@link COMMAND_SPECS}. Pure —
 * callers (`program.ts`) handle stdout via `writeJson`.
 */
export function buildCommandsList(filter) {
    const items = filterCommandSpecs(COMMAND_SPECS, filter);
    return { items, nextCursor: null, count: items.length };
}
//# sourceMappingURL=commandsList.js.map