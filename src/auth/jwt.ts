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
  /** Impersonation actor personId (`imp` claim) — present only on impersonation tokens. */
  imp?: number;
  /** Impersonation session id (`imp_sid` claim) — present only on impersonation tokens. */
  imp_sid?: string;
  /**
   * Every company this token may act as (the `company switch` targets), each
   * with the role NAMES held there. From `asiakasesWithTypes`. The JWT carries
   * NO company name for these entries (only the active company has
   * `ownerAsiakasName`) — resolve names with `ib company list` when needed.
   * Empty on short/absent tokens.
   */
  companies: Array<{ asiakasId: number; roles: string[] }>;
}

/**
 * Lazily-resolved `@ibetoni/auth/codec` `expandPayload`. Loading the codec
 * costs ~20 ms, so it is resolved at most ONCE per process — and only when a
 * payload actually looks short-shape: v2 short tokens carry a `v` version
 * field (`isShortShape` in the codec checks exactly that), and `expandPayload`
 * returns long-shape payloads unchanged, so skipping it for them is a no-op.
 * `null` caches the "unavailable" verdict (e.g. unit tests without the
 * workspace symlink).
 */
type ExpandPayload = (p: Record<string, unknown>) => Record<string, unknown>;
let expandPayloadFn: ExpandPayload | null | undefined;

function resolveExpandPayload(): ExpandPayload | null {
  if (expandPayloadFn === undefined) {
    try {
      const require = createRequire(import.meta.url);
      const codec = require("@ibetoni/auth/codec") as { expandPayload?: ExpandPayload };
      expandPayloadFn =
        typeof codec.expandPayload === "function" ? codec.expandPayload : null;
    } catch {
      expandPayloadFn = null;
    }
  }
  return expandPayloadFn;
}

// One invocation decodes the SAME token several times (tier resolution in
// bin/ib.ts, the acting-as diagnostic and impersonation check in cliContext) —
// cache the last decode. Callers treat DecodedClaims as read-only.
let lastToken: string | undefined;
let lastClaims: DecodedClaims | undefined;

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
  if (jwt === lastToken && lastClaims) return lastClaims;
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  const raw = JSON.parse(json) as Record<string, unknown>;

  let expanded: Record<string, unknown> = raw;
  if (raw.v !== undefined) {
    try {
      expanded = resolveExpandPayload()?.(raw) ?? raw;
    } catch {
      // Codec rejected the payload (e.g. unknown role) — use raw shape, as the
      // old always-wrapped try/catch did.
    }
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

  const companyList = companies
    .map((c) => ({
      asiakasId: finite(c?.asiakasId),
      roles: Array.isArray(c?.roles) ? (c.roles as string[]) : [],
    }))
    .filter((c): c is { asiakasId: number; roles: string[] } => c.asiakasId !== undefined);

  const claims: DecodedClaims = {
    personId: finite(expanded.personId ?? expanded.sub),
    ownerAsiakasId: finite(expanded.ownerAsiakasId ?? expanded.o),
    ownerAsiakasName: expanded.ownerAsiakasName as string | undefined,
    email: expanded.email as string | undefined,
    issuedFor: expanded.issuedFor as "cli" | "mcp" | "web" | undefined,
    exp: typeof expanded.exp === "number" ? expanded.exp : undefined,
    isSystemAdmin: globalRoles.isSystemAdmin === true,
    isDeveloper: globalRoles.isDeveloper === true,
    isActiveCompanyAdmin,
    imp: finite(expanded.imp ?? expanded.i),
    imp_sid: (expanded.imp_sid ?? expanded.s) as string | undefined,
    companies: companyList,
  };
  lastToken = jwt;
  lastClaims = claims;
  return claims;
}

/** The orientation shape for an active impersonation session. */
export interface ImpersonationInfo {
  actorPersonId: number;
  sessionId: string;
}

/**
 * Project the impersonation claims (`imp`/`imp_sid`) into the orientation shape
 * shared by `auth whoami`, `doctor`, and `person me`. Returns `undefined` on a
 * normal (non-impersonation) token. Kept in one place so the three surfaces
 * can't drift in how they report "am I acting as someone else?".
 */
export function impersonationFromClaims(claims: DecodedClaims): ImpersonationInfo | undefined {
  return claims.imp != null
    ? { actorPersonId: claims.imp, sessionId: claims.imp_sid ?? "" }
    : undefined;
}
