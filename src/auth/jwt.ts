import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

export interface DecodedClaims {
  /** Absent/undefined when the token carries no `personId`/`sub` claim (was
   * silently `NaN` before, which leaked the literal "NaN" into URLs). */
  personId: number | undefined;
  /** Absent/undefined when the token carries no `ownerAsiakasId`/`o` claim. */
  ownerAsiakasId: number | undefined;
  ownerAsiakasName?: string;
  email?: string;
  issuedFor?: "cli" | "mcp" | "web";
  /** JWT `exp` (seconds since epoch), when present. Used by `ib doctor`. */
  exp?: number;
  /** From JWT `globalRoles` — used by `ib legal accept` dev-gate. */
  isSystemAdmin: boolean;
  isDeveloper: boolean;
  /**
   * True when the ACTIVE company (`ownerAsiakasId`) grants `asiakasAdmin` or
   * `hrAdmin`. Drives the "admin" visibility tier (e.g. `ib notification fcm`).
   * False on short/absent tokens (fail-closed to non-admin).
   */
  isActiveCompanyAdmin: boolean;
}

/**
 * Decode a JWT payload into typed claims.
 *
 * Uses `@ibetoni/auth/codec` `expandPayload` when reachable so we transparently
 * handle the short-shape JWT (`f` -> `issuedFor`, etc.) introduced in Plan 1.
 * Falls back to a raw base64url decode when the codec is unavailable — that
 * fallback is also the unit-test path (tests construct minimal `header.body.sig`
 * fixtures and don't depend on the workspace package being symlinked).
 */
export function decodeJwtPayload(jwt: string): DecodedClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  const raw = JSON.parse(json) as Record<string, unknown>;

  let expanded: Record<string, unknown> = raw;
  try {
    const require = createRequire(import.meta.url);
    const codec = require("@ibetoni/auth/codec") as {
      expandPayload?: (p: Record<string, unknown>) => Record<string, unknown>;
    };
    if (typeof codec.expandPayload === "function") {
      expanded = codec.expandPayload(raw);
    }
  } catch {
    // Codec unavailable (e.g., during unit tests that mock JWTs). Use raw shape.
  }

  const globalRoles = (expanded.globalRoles ?? {}) as Record<string, unknown>;

  // A missing claim must surface as `undefined`, not `Number(undefined)` → NaN
  // (NaN serialises into a URL/query as the literal "NaN").
  const finite = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // Active-company admin: asiakasesWithTypes carries role NAMES per company;
  // read the entry for ownerAsiakasId (the active tenant). asiakasAdmin/hrAdmin
  // mirror canSendCliNotification's gate. Absent/short token → false.
  const owner = finite(expanded.ownerAsiakasId ?? expanded.o);
  const companies = Array.isArray(expanded.asiakasesWithTypes)
    ? (expanded.asiakasesWithTypes as Array<{ asiakasId?: unknown; roles?: unknown }>)
    : [];
  const activeRoles = companies
    .filter((c) => finite(c?.asiakasId) === owner)
    .flatMap((c) => (Array.isArray(c?.roles) ? (c.roles as unknown[]) : []));
  const isActiveCompanyAdmin =
    owner !== undefined &&
    (activeRoles.includes("asiakasAdmin") || activeRoles.includes("hrAdmin"));

  return {
    personId: finite(expanded.personId ?? expanded.sub),
    ownerAsiakasId: finite(expanded.ownerAsiakasId ?? expanded.o),
    ownerAsiakasName: expanded.ownerAsiakasName as string | undefined,
    email: expanded.email as string | undefined,
    issuedFor: expanded.issuedFor as "cli" | "mcp" | "web" | undefined,
    exp: typeof expanded.exp === "number" ? expanded.exp : undefined,
    isSystemAdmin: globalRoles.isSystemAdmin === true,
    isDeveloper: globalRoles.isDeveloper === true,
    isActiveCompanyAdmin,
  };
}
