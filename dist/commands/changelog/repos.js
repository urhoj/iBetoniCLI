/**
 * Canonical repo model for changelog attribution — TS mirror of
 * `puminet5api/modules/changelog/repos.js` (the single source of truth,
 * also consumed by the deploy planner `scripts/lib/computeReleasePlan.js`).
 * KEEP IN SYNC with that file: same COORDINATED set, same ALIASES table,
 * same token semantics. The CLI can't import the backend CJS module
 * cross-submodule (the vendored dist must build standalone), hence the copy.
 *
 * Warning semantics (fb#228): `npm run deploy` Step 0 fail-safe-bumps ALL
 * coordinated repos ONLY when a CSV resolves to coordinated=[] AND
 * canonical=[] (nothing recognized at all) — a recognized-but-non-coordinated
 * repo (betonicli, @ibetoni/*, dbo.*, site submodules) is the standalone
 * lane and triggers no app bump.
 */
export const COORDINATED = [
    "puminet4",
    "puminet5api",
    "puminet7-functions-app",
    "betonijerry",
    "workspace",
];
// alias (lowercased) -> canonical. Canonical names also map to themselves.
const ALIASES = {
    puminet4: "puminet4", fe: "puminet4", frontend: "puminet4",
    puminet5api: "puminet5api", be: "puminet5api", backend: "puminet5api", api: "puminet5api", p5api: "puminet5api",
    "puminet7-functions-app": "puminet7-functions-app", functions: "puminet7-functions-app", puminet7: "puminet7-functions-app",
    betonijerry: "betonijerry", jerry: "betonijerry",
    workspace: "workspace", ws: "workspace", root: "workspace", monorepo: "workspace",
    betonicli: "betonicli", cli: "betonicli",
    ibetoni_packages: "ibetoni_packages", packages: "ibetoni_packages", shared: "ibetoni_packages",
    database: "database", db: "database",
    // Standalone-lane site submodules (own repos/releases, no coordinated bump — feedback #214).
    "ibetoni-site": "ibetoni-site", site: "ibetoni-site", ibetonisite: "ibetoni-site",
    bsg2: "bsg2",
};
/** One token -> canonical name, or null if unknown. `dbo.*` / `@ibetoni/*` pass through verbatim. */
export function normalizeRepoToken(token) {
    const t = String(token == null ? "" : token).trim();
    if (!t)
        return null;
    if (/^dbo\./i.test(t))
        return t;
    if (/^@ibetoni\//i.test(t))
        return t;
    return ALIASES[t.toLowerCase()] || null;
}
/** CSV -> { canonical (deduped CSV), coordinated (subset), unknown (unresolved tokens) }. */
export function normalizeRepoCsv(csv) {
    const tokens = String(csv == null ? "" : csv).split(",").map((s) => s.trim()).filter(Boolean);
    const canonical = [];
    const coordinated = [];
    const unknown = [];
    for (const tok of tokens) {
        const c = normalizeRepoToken(tok);
        if (c == null) {
            unknown.push(tok);
            continue;
        }
        if (!canonical.includes(c))
            canonical.push(c);
        if (COORDINATED.includes(c) && !coordinated.includes(c))
            coordinated.push(c);
    }
    return { canonical: canonical.join(","), coordinated, unknown };
}
//# sourceMappingURL=repos.js.map