import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  buildAsiakasCreateBody,
  extractAsiakasId,
} from "../../src/commands/customer/index.js";

describe("buildAsiakasCreateBody", () => {
  test("injects ownerAsiakasId and maps flags to createY columns", () => {
    const body = buildAsiakasCreateBody(
      { name: "Acme Oy", ytunnus: "1234567-8", email: "a@b.fi", shortName: "Acme" },
      1349
    );
    expect(body).toEqual({
      ownerAsiakasId: 1349,
      asiakasNimi: "Acme Oy",
      yTunnus: "1234567-8",
      email: "a@b.fi",
      asiakasShortNimi: "Acme",
    });
  });

  test("precedence: --body > explicit flags > PRH prefill", () => {
    const prh = {
      businessId: "0145937-9", name: "PRH Name", tradeNames: [], address: null,
      companyForm: null, status: "active",
    };
    const body = buildAsiakasCreateBody(
      { name: "Flag Name", body: '{"asiakasNimi":"Body Name"}' },
      1349,
      prh
    );
    expect(body.yTunnus).toBe("0145937-9");
    expect(body.asiakasNimi).toBe("Body Name");
    expect(body.ownerAsiakasId).toBe(1349);
  });
});

describe("extractAsiakasId", () => {
  test("reads returnValue, then asiakasId, then recordset fallbacks", () => {
    expect(extractAsiakasId({ returnValue: 5001 })).toBe(5001);
    expect(extractAsiakasId({ asiakasId: 5002 })).toBe(5002);
    expect(extractAsiakasId({ recordset: [{ asiakasId: 5003 }] })).toBe(5003);
    expect(extractAsiakasId({ nope: true })).toBeNull();
  });
});
