import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

export interface DecodedClaims {
  personId: number;
  ownerAsiakasId: number;
  ownerAsiakasName?: string;
  email?: string;
  issuedFor?: "cli" | "mcp" | "web";
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

  return {
    personId: Number(expanded.personId ?? expanded.sub),
    ownerAsiakasId: Number(expanded.ownerAsiakasId ?? expanded.o),
    ownerAsiakasName: expanded.ownerAsiakasName as string | undefined,
    email: expanded.email as string | undefined,
    issuedFor: expanded.issuedFor as "cli" | "mcp" | "web" | undefined,
  };
}
