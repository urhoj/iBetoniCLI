import { describe, test, expect, vi } from "vitest";
import {
  runLegalTypes,
  runLegalShow,
  runLegalStatus,
  runLegalVersions,
  runLegalGet,
  runLegalSave,
  runLegalActivate,
  runLegalDelete,
  runLegalAcceptances,
  runLegalAccept,
  assertDeveloperClaims,
} from "../../src/commands/legal/index.js";
import type { ApiClient } from "../../src/api/client.js";
import type { DecodedClaims } from "../../src/auth/jwt.js";

function mockClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn().mockReturnValue("t"),
  } as unknown as ApiClient;
}

const TYPES = [
  { documentTypeId: 2, typeName: "TOS", displayName: "Käyttöehdot", personSettingTypeId: 40 },
  { documentTypeId: 5, typeName: "GLOBAL", displayName: "Global", personSettingTypeId: null },
];

describe("ib legal reads", () => {
  test("types -> ListEnvelope over GET /types", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue(TYPES);
    const out = await runLegalTypes(c);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/types");
    expect(out).toEqual({ items: TYPES, nextCursor: null, count: 2 });
  });

  test("show --meta strips markdownContent, keeps contentLength", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      documentId: 1, version: "1.0", markdownContent: "# hello",
    });
    const out = await runLegalShow(c, "TOS", true);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/current/TOS");
    expect(out).toEqual({ documentId: 1, version: "1.0", contentLength: 7 });
  });

  test("status strips content from missing docs and passes owner", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      missingAcceptances: [{ typeName: "TOS", version: "2.0", markdownContent: "BIG" }],
      acceptedAcceptances: [{ typeName: "PRIVACY", acceptedVersion: "1.0" }],
      requiresAcceptance: true,
      totalDocuments: 2,
    });
    const out = await runLegalStatus(c, 5, 10);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/check-acceptances/5?ownerAsiakasId=10");
    expect(out.requiresAcceptance).toBe(true);
    expect(out.missing[0]).not.toHaveProperty("markdownContent");
    expect(out.accepted).toHaveLength(1);
  });

  test("versions strips content, returns envelope", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      { documentId: 1, version: "1.0", isActive: false, markdownContent: "BIG" },
    ]);
    const out = await runLegalVersions(c, "TOS", undefined);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/TOS/versions");
    expect(out.items[0]).not.toHaveProperty("markdownContent");
    expect(out.count).toBe(1);
  });

  test("get fetches one document by id", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({ documentId: 9 });
    await runLegalGet(c, 9);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/document/9");
  });

  test("acceptances projects server payload into envelope with truncated", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      typeName: "TOS", personSettingTypeId: 40, count: 1, truncated: true,
      acceptances: [{ personId: 5, acceptedVersion: "1.0" }],
    });
    const out = await runLegalAcceptances(c, "TOS", { version: "1.0", limit: 1 });
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/acceptances/TOS?version=1.0&limit=1");
    expect(out).toEqual(expect.objectContaining({
      count: 1, truncated: true, nextCursor: null, typeName: "TOS",
    }));
  });
});

describe("ib legal writes", () => {
  test("save resolves typeName -> documentTypeId, forwards X-Dry-Run", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue(TYPES);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValue({ documentId: 11, success: true });
    await runLegalSave(c, {
      typeName: "TOS", version: "2.0", title: "T", markdownContent: "# x", activate: false,
    }, { dryRun: true, reason: "preview" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/legal-documents/save",
      expect.objectContaining({ documentTypeId: 2, version: "2.0", activate: false, ownerAsiakasId: null }),
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "preview" } }
    );
  });

  test("save with unknown typeName -> exit-5 CliError, no POST", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue(TYPES);
    await expect(runLegalSave(c, {
      typeName: "NOPE", version: "1.0", title: "T", markdownContent: "x",
    }, {})).rejects.toMatchObject({ exitCode: 5 });
    expect(c.post).not.toHaveBeenCalled();
  });

  test("activate PUTs with write headers", async () => {
    const c = mockClient();
    (c.put as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    await runLegalActivate(c, 7, { reason: "publish v2" });
    expect(c.put).toHaveBeenCalledWith(
      "/api/legal-documents/activate/7", {}, { headers: { "X-Action-Reason": "publish v2" } });
  });

  test("delete DELETEs with write headers", async () => {
    const c = mockClient();
    (c.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    await runLegalDelete(c, 7, { dryRun: true });
    expect(c.delete).toHaveBeenCalledWith(
      "/api/legal-documents/7", { headers: { "X-Dry-Run": "1" } });
  });

  test("accept composes current doc + settingTypeId and posts self-acceptance", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ documentId: 3, version: "2.0" })
      .mockResolvedValueOnce(TYPES);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    await runLegalAccept(c, "TOS", 5, { reason: "e2e test" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/legal-documents/record-acceptance",
      { personId: 5, documentId: 3, settingTypeId: 40, version: "2.0" },
      { headers: { "X-Action-Reason": "e2e test" } }
    );
  });

  test("accept on type with null settingTypeId -> exit 4, no POST", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ documentId: 8, version: "1.0" })
      .mockResolvedValueOnce(TYPES);
    await expect(runLegalAccept(c, "GLOBAL", 5, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(c.post).not.toHaveBeenCalled();
  });
});

describe("assertDeveloperClaims", () => {
  const CLAIMS: DecodedClaims = { personId: 5, ownerAsiakasId: 10, isSystemAdmin: false, isDeveloper: false };
  test("non-dev throws exit-3", () => {
    expect(() => assertDeveloperClaims(CLAIMS)).toThrowError();
  });
  test("developer passes", () => {
    expect(() => assertDeveloperClaims({ ...CLAIMS, isDeveloper: true })).not.toThrow();
  });
  test("sysadmin passes", () => {
    expect(() => assertDeveloperClaims({ ...CLAIMS, isSystemAdmin: true })).not.toThrow();
  });
});
