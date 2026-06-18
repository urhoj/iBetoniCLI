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

  test("extracts isSystemAdmin independently of isDeveloper", () => {
    const claims = decodeJwtPayload(
      fakeJwt({ personId: 5, ownerAsiakasId: 10, globalRoles: { isSystemAdmin: true } })
    );
    expect(claims.isSystemAdmin).toBe(true);
    expect(claims.isDeveloper).toBe(false);
  });
});

describe("decodeJwtPayload numeric ids", () => {
  test("absent personId/ownerAsiakasId decode to undefined, not NaN", () => {
    const claims = decodeJwtPayload(fakeJwt({ email: "a@b.fi" }));
    expect(claims.personId).toBeUndefined();
    expect(claims.ownerAsiakasId).toBeUndefined();
    // The bug: Number(undefined) → NaN, which interpolates into URLs as "NaN".
    expect(Number.isNaN(claims.personId as number)).toBe(false);
  });

  test("present ids decode to numbers", () => {
    const claims = decodeJwtPayload(fakeJwt({ personId: 5, ownerAsiakasId: 10 }));
    expect(claims.personId).toBe(5);
    expect(claims.ownerAsiakasId).toBe(10);
  });
});
