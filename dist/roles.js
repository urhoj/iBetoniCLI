import { createRequire } from "node:module";
// `@ibetoni/constants` is CommonJS — pull in via createRequire so the ESM
// build needs no default-export shim. ROLE_NAME_BY_TYPEID / ROLE_TYPEID_BY_NAME
// are the single source of truth for the role typeId↔name mapping.
const cjsRequire = createRequire(import.meta.url);
// Lazily require + cache the role maps from the CommonJS @ibetoni/constants
// package. Lazy (first call) so test imports don't need the workspace symlink at
// module-eval time; cached so repeated lookups don't re-destructure. Mirrors the
// memoized-accessor pattern in commands/customer/index.ts (settingTypeIdMap).
let cachedRoleMaps;
function roleMaps() {
    if (!cachedRoleMaps) {
        cachedRoleMaps = cjsRequire("@ibetoni/constants");
    }
    return cachedRoleMaps;
}
/**
 * Translate a role NAME (e.g. "keikkaHandler") to its asiakasPersonSettingTypeId
 * via ROLE_TYPEID_BY_NAME. Returns 0 for an unset name (callers treat 0 as
 * "no filter"). Throws a descriptive error listing valid names when the role is
 * unknown so the CLI can surface them.
 */
export function resolveRoleTypeId(roleName) {
    if (!roleName)
        return 0;
    const { ROLE_TYPEID_BY_NAME } = roleMaps();
    const id = ROLE_TYPEID_BY_NAME[roleName];
    if (!id) {
        const valid = Object.keys(ROLE_TYPEID_BY_NAME).sort().join(", ");
        throw new Error(`unknown role: ${roleName}. Valid: ${valid}`);
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
        throw new Error(`unknown role: ${roleName}`);
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