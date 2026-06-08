import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
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
    const needle = filter.permission?.toLowerCase();
    return specs
        .filter((s) => {
        if (filter.mutations && !s.writeFlags)
            return false;
        if (filter.reads && s.writeFlags)
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
        writeFlags: !!s.writeFlags,
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