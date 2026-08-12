import { createRequire } from "node:module";
import { failWith } from "./output/json.js";
// Lazily require + cache the role maps from the CommonJS @ibetoni/constants
// package (createRequire included — at module scope it ran on every start, and
// most invocations never touch a role). Lazy (first call) so test imports don't
// need the workspace symlink at module-eval time; cached so repeated lookups
// don't re-destructure. Mirrors the memoized-accessor pattern in
// commands/customer/index.ts (settingTypeIdMap) and auth/jwt.ts.
let cachedRoleMaps;
function roleMaps() {
    if (!cachedRoleMaps) {
        cachedRoleMaps = createRequire(import.meta.url)("@ibetoni/constants");
    }
    return cachedRoleMaps;
}
/**
 * Names that are NOT roles here but that the product/DB uses for two DIFFERENT
 * roles at once. Dumping the valid-name list (the generic unknown-role path)
 * is useless for these: nothing in it looks like the word you typed, so you
 * pick by coin-flip and the wrong choice fails silently downstream. Aliasing
 * one of them would just relocate the bug, so we refuse and name both with
 * what each actually gates (feedback #418). Keyed lowercase.
 */
const AMBIGUOUS_ROLE_NAMES = {
    tarjousadmin: [
        "names TWO different roles in this system, so it cannot be resolved:",
        "  laskupohjaAdmin (typeId 1) — described as isTarjousAdmin in",
        "    dbo.asiakasPersonSettingTypes + @ibetoni/constants; appears in the",
        "    BetoniJerry email-recipient fallback and `ib jerry admin detail`.admins.",
        "  laskuAdmin (typeId 5) — what the Jerry admin dashboard's tarjousAdminCount",
        "    and the Jerry validation profile's people.tarjousAdmin check read.",
        "Grant the explicit name. For BetoniJerry provider onboarding the validation",
        "profile wants laskuAdmin; laskupohjaAdmin is the one the DB calls TarjousAdmin.",
    ].join("\n"),
};
/**
 * Translate a role NAME (e.g. "keikkaHandler") to its asiakasPersonSettingTypeId
 * via ROLE_TYPEID_BY_NAME. Returns 0 for an unset name (callers treat 0 as
 * "no filter"). An unknown name exits 4 (validation) via `failWith`, so
 * `exitWithError` maps it to the documented exit-code contract instead of the
 * generic `1`; the message lists the valid names so the CLI can surface them —
 * except for a known-ambiguous name, which gets the disambiguation instead.
 */
export function resolveRoleTypeId(roleName) {
    if (!roleName)
        return 0;
    const { ROLE_TYPEID_BY_NAME } = roleMaps();
    const id = ROLE_TYPEID_BY_NAME[roleName];
    if (!id) {
        const ambiguous = AMBIGUOUS_ROLE_NAMES[roleName.toLowerCase()];
        if (ambiguous)
            failWith(`"${roleName}" ${ambiguous}`, 4);
        const valid = Object.keys(ROLE_TYPEID_BY_NAME).sort().join(", ");
        failWith(`unknown role: ${roleName}. Valid: ${valid}`, 4);
    }
    return id;
}
/** Translate an asiakasPersonSettingTypeId to its role NAME, or null if unknown. */
export function roleNameForTypeId(typeId) {
    return roleMaps().ROLE_NAME_BY_TYPEID[typeId] ?? null;
}
// tier label → the @ibetoni/constants grouping array that confers it.
const TIER_GROUPS = [
    { tier: "anyAdmin", key: "ASIAKAS_ANY_ADMIN_ROLE_TYPE_IDS" },
    { tier: "anyWorker", key: "ASIAKAS_ANY_WORKER_ROLE_TYPE_IDS" },
    { tier: "anyViewer", key: "ASIAKAS_ANY_VIEWER_ROLE_TYPE_IDS" },
    { tier: "laskuRead", key: "ASIAKAS_LASKU_READ_ROLE_TYPE_IDS" },
    { tier: "requestOffer", key: "ASIAKAS_REQUEST_OFFER_ROLE_TYPE_IDS" },
    { tier: "adminCompanySelection", key: "ADMIN_COMPANY_ROLE_TYPE_IDS" },
];
/** OBSOLETE typeIds kept only for legacy data round-trip (pumppuHandler/Viewer). */
const DEPRECATED_ROLE_TYPEIDS = [20, 21];
/**
 * Explain a role NAME: its typeId, human display name, the access tiers it
 * grants, and whether it is deprecated (all from @ibetoni/constants), enriched
 * with the live DB description + comment (GET /api/asiakasPersonSettings/getAllTypes).
 *
 * The role-name validation runs FIRST (before any network call) so an unknown
 * name fails cheap/offline with the same descriptive "unknown role: …" error as
 * {@link resolveRoleTypeId}. description/comment are `null` for roles the
 * endpoint omits (e.g. soft-deleted pumppuHandler/Viewer 20/21).
 */
export async function explainRole(client, roleName) {
    const typeId = resolveRoleTypeId(roleName);
    if (!typeId)
        failWith(`unknown role: ${roleName}`, 4);
    const maps = roleMaps();
    const tiers = TIER_GROUPS.filter(({ key }) => maps[key].includes(typeId)).map(({ tier }) => tier);
    const types = await client.get("/api/asiakasPersonSettings/getAllTypes");
    const row = Array.isArray(types)
        ? types.find((t) => t.asiakasPersonSettingTypeId === typeId)
        : undefined;
    return {
        role: roleName,
        typeId,
        displayName: maps.TYPE_ID_TO_ROLE_NAME[typeId] ?? null,
        description: row?.asiakasPersonSettingTypeDescription ?? null,
        comment: row?.asiakasPersonSettingTypeComment ?? null,
        tiers,
        deprecated: DEPRECATED_ROLE_TYPEIDS.includes(typeId),
    };
}
//# sourceMappingURL=roles.js.map