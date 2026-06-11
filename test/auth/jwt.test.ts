import { describe, test, expect } from "vitest";
import { Buffer } from "node:buffer";
import { decodeJwtPayload } from "../../src/auth/jwt.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

describe("decodeJwtPayload globalRoles", () => {
  test("extracts isDeveloper/isSystemAdmin from globalRoles", () => {
    const claims = decodeJwtPayload(
      fakeJwt({ personId: 5, ownerAsiakasId: 10, globalRoles: { isDeveloper: true } })
    );
    expect(claims.isDeveloper).toBe(true);
    expect(claims.isSystemAdmin).toBe(false);
  });

  test("defaults to false when globalRoles missing", () => {
    const claims = decodeJwtPayload(fakeJwt({ personId: 5, ownerAsiakasId: 10 }));
    expect(claims.isDeveloper).toBe(false);
    expect(claims.isSystemAdmin).toBe(false);
  });
});
