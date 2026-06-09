import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runPersonCreate,
  runPersonUpdate,
  runPersonDelete,
  buildPersonCreateBody,
  missingPersonCreateFields,
  extractPersonId,
  isDuplicateEmailError,
  runPersonByEmail,
} from "../../src/commands/person/index.js";
import { CliError } from "../../src/api/errors.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runPersonCreate", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs /api/person/newPerson with body and write-flag headers", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ personId: 5351 });
    const body = { personFirstName: "Test", personLastName: "User", personEmail: "test@x.com" };
    await runPersonCreate(mockClient, body, { reason: "lifecycle", idempotencyKey: "k1" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/newPerson",
      body,
      { headers: { "X-Action-Reason": "lifecycle", "Idempotency-Key": "k1" } }
    );
  });
});

describe("buildPersonCreateBody (typed-flag merge)", () => {
  test("maps typed flags to backend column names", () => {
    expect(
      buildPersonCreateBody({}, { first: "Matti", last: "Virtanen", phone: "+358501234567", asiakas: 8 })
    ).toEqual({
      personFirstName: "Matti",
      personLastName: "Virtanen",
      personPhone: "+358501234567",
      ownerAsiakasId: 8,
    });
  });

  test("omits personEmail entirely when --email not given (phone-only contact)", () => {
    const body = buildPersonCreateBody({}, { first: "Matti", last: "Virtanen" });
    expect("personEmail" in body).toBe(false);
  });

  test("typed flags win over --body keys; untouched body keys preserved", () => {
    expect(
      buildPersonCreateBody({ personFirstName: "Old", personMemo: "keep" }, { first: "New" })
    ).toEqual({ personFirstName: "New", personMemo: "keep" });
  });

  test("--global sets ownerAsiakasId to null (explicit global person)", () => {
    expect(buildPersonCreateBody({}, { first: "Matti", last: "Virtanen", global: true })).toEqual({
      personFirstName: "Matti",
      personLastName: "Virtanen",
      ownerAsiakasId: null,
    });
  });

  test("--global wins over a --body ownerAsiakasId", () => {
    expect(buildPersonCreateBody({ ownerAsiakasId: 8 }, { global: true })).toEqual({
      ownerAsiakasId: null,
    });
  });
});

describe("missingPersonCreateFields", () => {
  test("requires first + last, but NOT email", () => {
    expect(missingPersonCreateFields({ personFirstName: "Matti", personLastName: "Virtanen" })).toEqual([]);
  });

  test("flags missing first/last (null/empty count as missing)", () => {
    expect(missingPersonCreateFields({ personFirstName: "", personLastName: null })).toEqual([
      "--first (personFirstName)",
      "--last (personLastName)",
    ]);
  });
});

describe("extractPersonId", () => {
  test("reads returnValue at top level and nested under data", () => {
    expect(extractPersonId({ returnValue: 6263 })).toBe(6263);
    expect(extractPersonId({ status: "ok", data: { returnValue: 6263 } })).toBe(6263);
  });
  test("falls back to recordset[0].personId", () => {
    expect(extractPersonId({ data: { recordset: [{ personId: 42 }] } })).toBe(42);
  });
  test("returns null when no id is present", () => {
    expect(extractPersonId({ status: "ok", data: {} })).toBeNull();
    expect(extractPersonId(null)).toBeNull();
  });
});

describe("isDuplicateEmailError", () => {
  test("true for a 400 CliError saying the email is already in use", () => {
    const e = new CliError("Bad Request", 400, { error: "Sähköpostiosoite on jo käytössä." }, 4);
    expect(isDuplicateEmailError(e)).toBe(true);
  });
  test("false for other 400s and non-CliErrors", () => {
    expect(isDuplicateEmailError(new CliError("Bad Request", 400, { error: "Missing field" }, 4))).toBe(false);
    expect(isDuplicateEmailError(new Error("boom"))).toBe(false);
  });
});

describe("runPersonByEmail", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });
  test("returns a tidy person from the by-email recordset", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { personId: 6263, personFirstName: "Matti", personLastName: "Virtanen", personEmail: "m@x.com" },
    ]);
    const r = await runPersonByEmail(mockClient, "m@x.com");
    expect(mockClient.get).toHaveBeenCalledWith("/api/person/getPersonByEmail/m%40x.com");
    expect(r).toEqual({ personId: 6263, name: "Matti Virtanen", email: "m@x.com" });
  });
  test("returns null on an empty result", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    expect(await runPersonByEmail(mockClient, "x@y.com")).toBeNull();
  });
});

describe("runPersonUpdate", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs /api/person/set with body containing personId", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await runPersonUpdate(mockClient, 5351, { personPhone: "+358501234567" }, { reason: "phone update" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/set",
      { personId: 5351, personPhone: "+358501234567" },
      { headers: { "X-Action-Reason": "phone update" } }
    );
  });
});

describe("runPersonDelete", () => {
  beforeEach(() => { (mockClient.delete as ReturnType<typeof vi.fn>).mockReset(); });

  test("DELETEs /api/person/delete/<personId> with reason header", async () => {
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deleted: 5351 });
    const result = await runPersonDelete(mockClient, 5351, { reason: "cleanup" });
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/person/delete/5351",
      { headers: { "X-Action-Reason": "cleanup" } }
    );
    expect(result).toEqual({ deleted: 5351 });
  });
});
