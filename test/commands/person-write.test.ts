import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runPersonCreate,
  runPersonUpdate,
  runPersonDelete,
  buildPersonCreateBody,
  missingPersonCreateFields,
} from "../../src/commands/person/index.js";
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
