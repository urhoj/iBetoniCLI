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

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

function mkJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("decodeJwtPayload impersonation claims", () => {
  test("surfaces imp and imp_sid when present", () => {
    const c = decodeJwtPayload(mkJwt({ personId: 42, ownerAsiakasId: 1349, imp: 10, imp_sid: "abc" }));
    expect(c.imp).toBe(10);
    expect(c.imp_sid).toBe("abc");
  });

  test("imp/imp_sid undefined on a normal login token", () => {
    const c = decodeJwtPayload(mkJwt({ personId: 42, ownerAsiakasId: 1349 }));
    expect(c.imp).toBeUndefined();
    expect(c.imp_sid).toBeUndefined();
  });
});

describe("decodeJwtPayload — isActiveCompanyAdmin", () => {
  test("asiakasAdmin on the active company → true", () => {
    const token = jwt({
      ownerAsiakasId: 8,
      asiakasesWithTypes: [
        { asiakasId: 8, roles: ["asiakasAdmin", "keikkaHandler"] },
        { asiakasId: 9, roles: ["keikkaViewer"] },
      ],
    });
    expect(decodeJwtPayload(token).isActiveCompanyAdmin).toBe(true);
  });
  test("hrAdmin on the active company → true", () => {
    const token = jwt({ ownerAsiakasId: 8, asiakasesWithTypes: [{ asiakasId: 8, roles: ["hrAdmin"] }] });
    expect(decodeJwtPayload(token).isActiveCompanyAdmin).toBe(true);
  });
  test("admin only on a DIFFERENT company → false (active-company scoped)", () => {
    const token = jwt({ ownerAsiakasId: 8, asiakasesWithTypes: [{ asiakasId: 9, roles: ["asiakasAdmin"] }] });
    expect(decodeJwtPayload(token).isActiveCompanyAdmin).toBe(false);
  });
  test("no asiakasesWithTypes → false (fail-closed)", () => {
    expect(decodeJwtPayload(jwt({ ownerAsiakasId: 8 })).isActiveCompanyAdmin).toBe(false);
  });
  test("no ownerAsiakasId + entry without asiakasId → false (fail-closed guard)", () => {
    const token = jwt({ asiakasesWithTypes: [{ roles: ["asiakasAdmin"] }] });
    expect(decodeJwtPayload(token).isActiveCompanyAdmin).toBe(false);
  });
});
