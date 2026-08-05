/**
 * Back-compat command aliases, as data.
 *
 * Two re-homings left old paths behind as hidden, still-executable aliases:
 * the `ib dev` umbrella (2026-06-30, seven groups) and `ib opendata`
 * (`ib weather *` → `ib opendata weather *`, `ib customer prh` → `ib opendata
 * prh`). `COMMAND_SPECS` only ever carries the CANONICAL path, so every
 * consumer that looks a spec up by command path has to map an alias back first
 * — otherwise the alias resolves to nothing and the caller silently loses
 * whatever the spec provides:
 *
 *   - `attachRichHelp` → the whole rich `--help` (flags, permissions, output
 *     shape, error remedies, examples), i.e. the CLI's core promise that an AI
 *     can invoke a command from its help alone. `ib feedback create --help`
 *     rendered bare Commander output while `ib dev feedback create --help`
 *     rendered the full spec.
 *   - `formatGroupHelp` → the group's subcommand table; an unmapped alias group
 *     has zero matching specs and renders the misleading "not available at your
 *     access level" message instead.
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
/**
 * Every alias → canonical PREFIX pair. A path matches a pair when it equals the
 * alias or continues it at a word boundary (`ib weather forecast` matches
 * `ib weather`; `ib weatherx` does not). Listed most-specific first so a
 * multi-word alias is never shadowed by a shorter one that shares its head.
 *
 * This table is the single definition of "which runtime paths are aliases" —
 * `canonicalPath` resolves them, and `help-wiring.test.ts` derives its
 * deliberately spec-less leaves from it rather than restating the list.
 */
export const ALIAS_PREFIXES = [
    ["ib customer prh", "ib opendata prh"],
    ["ib weather", "ib opendata weather"],
    ...DEV_ALIAS_DOMAINS.map((d) => [`ib ${d}`, `ib dev ${d}`]),
];
/**
 * Map a runtime command path to the path `COMMAND_SPECS` uses.
 * `ib feedback create` → `ib dev feedback create`, `ib weather forecast` →
 * `ib opendata weather forecast`; anything else is returned unchanged
 * (including paths already at their canonical home).
 */
export function canonicalPath(path) {
    for (const [alias, canonical] of ALIAS_PREFIXES) {
        if (path === alias)
            return canonical;
        if (path.startsWith(`${alias} `))
            return canonical + path.slice(alias.length);
    }
    return path;
}
//# sourceMappingURL=aliasPaths.js.map