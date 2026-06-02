import { createRequire } from "node:module";

// `@ibetoni/constants` is CommonJS — pull in via createRequire so the ESM
// build needs no default-export shim. ROLE_NAME_BY_TYPEID / ROLE_TYPEID_BY_NAME
// are the single source of truth for the role typeId↔name mapping.
const cjsRequire = createRequire(import.meta.url);

/**
 * Translate a role NAME (e.g. "keikkaHandler") to its asiakasPersonSettingTypeId
 * via ROLE_TYPEID_BY_NAME. Returns 0 for an unset name (callers treat 0 as
 * "no filter"). Throws a descriptive error listing valid names when the role is
 * unknown so the CLI can surface them.
 */
export function resolveRoleTypeId(roleName?: string): number {
  if (!roleName) return 0;
  const { ROLE_TYPEID_BY_NAME } = cjsRequire("@ibetoni/constants") as {
    ROLE_TYPEID_BY_NAME: Record<string, number>;
  };
  const id = ROLE_TYPEID_BY_NAME[roleName];
  if (!id) {
    const valid = Object.keys(ROLE_TYPEID_BY_NAME).sort().join(", ");
    throw new Error(`unknown role: ${roleName}. Valid: ${valid}`);
  }
  return id;
}

/** Translate an asiakasPersonSettingTypeId to its role NAME, or null if unknown. */
export function roleNameForTypeId(typeId: number): string | null {
  const { ROLE_NAME_BY_TYPEID } = cjsRequire("@ibetoni/constants") as {
    ROLE_NAME_BY_TYPEID: Record<number, string>;
  };
  return ROLE_NAME_BY_TYPEID[typeId] ?? null;
}
