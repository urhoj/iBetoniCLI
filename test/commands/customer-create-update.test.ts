import { describe, test, expect } from "vitest";
import {
  buildAsiakasCreateBody,
  extractAsiakasId,
  buildAsiakasUpdateBody,
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

  test("does not prefill the 'Unknown' PRH name sentinel as asiakasNimi", () => {
    const prh = {
      businessId: "0145937-9", name: "Unknown", tradeNames: [], address: null,
      companyForm: null, status: "active",
    };
    const body = buildAsiakasCreateBody({}, 1349, prh);
    expect(body.yTunnus).toBe("0145937-9");
    expect("asiakasNimi" in body).toBe(false);
  });

  test("prefills billing address from PRH; explicit flags override", () => {
    const prh = {
      businessId: "0145937-9", name: "PRH Oy", tradeNames: [],
      address: { street: "Tehtaankatu 1", postCode: "00150", city: "Helsinki", full: "..." },
      companyForm: null, status: "active",
    };
    const body = buildAsiakasCreateBody({ city: "Espoo" }, 1349, prh);
    expect(body.laskutusOsoite).toBe("Tehtaankatu 1");
    expect(body.laskutusPostinumero).toBe("00150");
    expect(body.laskutusKaupunki).toBe("Espoo"); // flag wins over PRH city
  });

  test("maps --address/--postal-code/--city to laskutus columns", () => {
    const body = buildAsiakasCreateBody(
      { name: "Acme Oy", ytunnus: "1234567-8", address: "A St 2", postalCode: "02100", city: "Espoo" },
      1349
    );
    expect(body.laskutusOsoite).toBe("A St 2");
    expect(body.laskutusPostinumero).toBe("02100");
    expect(body.laskutusKaupunki).toBe("Espoo");
  });
});

describe("extractAsiakasId", () => {
  test("reads returnValue, then asiakasId, then recordset fallbacks", () => {
    expect(extractAsiakasId({ returnValue: 5001 })).toBe(5001);
    expect(extractAsiakasId({ asiakasId: 5002 })).toBe(5002);
    expect(extractAsiakasId({ recordset: [{ asiakasId: 5003 }] })).toBe(5003);
    expect(extractAsiakasId({ data: { returnValue: 5004 } })).toBe(5004);
    expect(extractAsiakasId({ nope: true })).toBeNull();
  });
});

describe("buildAsiakasUpdateBody (read-merge-write, no clobber)", () => {
  const current = {
    asiakasId: 26, name: "Old Oy", yTunnus: "1111111-1", type: 1,
    address: "A St", postalCode: "02100", city: "Espoo", email: "old@x.fi", phone: null,
    contactPersonId: 777, shortName: "OldOy", comment: "note",
  };

  test("seeds every setData field from current (incl. billing address) + saveGlobalAsiakas", () => {
    const body = buildAsiakasUpdateBody(current, {});
    expect(body).toEqual({
      ytunnus: "1111111-1",
      asiakasNimi: "Old Oy",
      asiakasTypeId: 1,
      laskutusEmail: "old@x.fi",
      asiakasContactPersonId: 777,
      asiakasShortNimi: "OldOy",
      kommentti: "note",
      laskutusOsoite: "A St",
      laskutusPostinumero: "02100",
      laskutusKaupunki: "Espoo",
      saveGlobalAsiakas: true,
    });
  });

  test("billing address flags override the seeded values", () => {
    const body = buildAsiakasUpdateBody(current, { address: "B St 9", postalCode: "00100", city: "Helsinki" });
    expect(body.laskutusOsoite).toBe("B St 9");
    expect(body.laskutusPostinumero).toBe("00100");
    expect(body.laskutusKaupunki).toBe("Helsinki");
  });

  test("provided flags override; --body wins last", () => {
    const body = buildAsiakasUpdateBody(current, {
      name: "New Oy", email: "new@x.fi", body: '{"kommentti":"forced"}',
    });
    expect(body.asiakasNimi).toBe("New Oy");
    expect(body.laskutusEmail).toBe("new@x.fi");
    expect(body.asiakasContactPersonId).toBe(777);
    expect(body.kommentti).toBe("forced");
  });

  test("defaults missing contact person to 0 (NOT NULL sentinel)", () => {
    const body = buildAsiakasUpdateBody({ ...current, contactPersonId: null }, {});
    expect(body.asiakasContactPersonId).toBe(0);
  });
});
