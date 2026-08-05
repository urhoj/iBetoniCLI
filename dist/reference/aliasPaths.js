/**
 * The `ib dev` re-homing (2026-06-30), as data.
 *
 * Seven groups moved under `ib dev <x>`; their old top-level paths stay
 * registered as hidden, still-executable back-compat aliases. `COMMAND_SPECS`
 * only ever carries the CANONICAL path, so every consumer that looks a spec up
 * by command path has to map an alias back first — otherwise the alias resolves
 * to nothing and the caller silently loses whatever the spec provides:
 *
 *   - `attachRichHelp` → the whole rich `--help` (flags, permissions, output
 *     shape, error remedies, examples), i.e. the CLI's core promise that an AI
 *     can invoke a command from its help alone. `ib feedback create --help`
 *     rendered bare Commander output while `ib dev feedback create --help`
 *     rendered the full spec.
 *   - `applySpecErrors` → the command's own documented error remedies, leaving
 *     only the generic per-status hint.
 *   - `buildUnknownOptionEnvelope` → the spec's flag list, degrading the
 *     did-you-mean to whatever Commander happens to know.
 *
 * Keeping the mapping here (with no imports, so any module can use it without a
 * cycle) means a future re-homing is one edit, not one edit per consumer.
 */
/** Domains whose canonical home is `ib dev <domain>` but whose bare `ib <domain>` still runs. */
export const DEV_ALIAS_DOMAINS = [
    "feedback",
    "changelog",
    "perf",
    "cache",
    "schema",
    "ai",
    "inbox",
];
const ALIASED = new Set(DEV_ALIAS_DOMAINS);
/**
 * Map a runtime command path to the path `COMMAND_SPECS` uses.
 * `ib feedback create` → `ib dev feedback create`; anything else is returned
 * unchanged (including paths already under `ib dev`).
 */
export function canonicalPath(path) {
    const parts = path.split(" ");
    if (parts.length < 2 || parts[0] !== "ib" || !ALIASED.has(parts[1]))
        return path;
    return `ib dev ${parts.slice(1).join(" ")}`;
}
//# sourceMappingURL=aliasPaths.js.map