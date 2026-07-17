import { describe, test, expect, vi } from "vitest";
import {
  runLegalTypes,
  runLegalShow,
  runLegalActive,
  runLegalDrafts,
  runLegalStatus,
  runLegalVersions,
  runLegalGet,
  parseLegalGetRef,
  runLegalDiff,
  runLegalSave,
  runLegalSaveWithEdit,
  runLegalActivate,
  runLegalDelete,
  runLegalAcceptances,
  runLegalAccept,
  resolveTypeNameTarget,
  assertDeveloperClaims,
  runLegalTypeCreate,
  runLegalTypeUpdate,
  pickTypeFields,
} from "../../src/commands/legal/index.js";
import { buildProgram } from "../../src/program.js";
import { CliError } from "../../src/api/errors.js";
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

  test("show without --meta returns full doc", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      documentId: 1, version: "1.0", markdownContent: "# hello",
    });
    const out = await runLegalShow(c, "TOS", false);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/current/TOS");
    expect(out).toHaveProperty("markdownContent", "# hello");
  });

  test("active rolls up every type, marking hasActive and stripping content", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(TYPES) // /types
      .mockResolvedValueOnce({
        documentId: 3, version: "2.0", title: "Käyttöehdot",
        effectiveDate: "2026-01-01", markdownContent: "# hello",
      }) // current/TOS
      .mockRejectedValueOnce(new CliError("not found", 404, null, 5)); // current/GLOBAL
    const out = await runLegalActive(c);
    expect(c.get).toHaveBeenNthCalledWith(1, "/api/legal-documents/types");
    expect(c.get).toHaveBeenNthCalledWith(2, "/api/legal-documents/current/TOS");
    expect(c.get).toHaveBeenNthCalledWith(3, "/api/legal-documents/current/GLOBAL");
    expect(out.count).toBe(2);
    expect(out.items[0]).toEqual({
      typeName: "TOS", displayName: "Käyttöehdot", personSettingTypeId: 40,
      hasActive: true, documentId: 3, version: "2.0", title: "Käyttöehdot",
      effectiveDate: "2026-01-01", contentLength: 7,
    });
    expect(out.items[0]).not.toHaveProperty("markdownContent");
    expect(out.items[1]).toEqual({
      typeName: "GLOBAL", displayName: "Global", personSettingTypeId: null,
      hasActive: false, documentId: null, version: null, title: null,
      effectiveDate: null, contentLength: null,
    });
  });

  test("active rethrows a non-404 error from a per-type fetch", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([TYPES[0]]) // single type -> no second fetch to race
      .mockRejectedValueOnce(new CliError("boom", 500, null, 6));
    await expect(runLegalActive(c)).rejects.toMatchObject({ exitCode: 6 });
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

  test("status with null owner omits the query string", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      missingAcceptances: [],
      acceptedAcceptances: [],
      requiresAcceptance: false,
    });
    await runLegalStatus(c, 5, null);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/check-acceptances/5");
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

  test("versions --status filters client-side", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      { documentId: 1, status: "active", markdownContent: "A" },
      { documentId: 2, status: "draft", markdownContent: "B" },
      { documentId: 3, status: "archived", markdownContent: "C" },
    ]);
    const out = await runLegalVersions(c, "TOS", undefined, "draft");
    expect(out.count).toBe(1);
    expect(out.items[0]).toMatchObject({ documentId: 2, status: "draft" });
    expect(out.items[0]).not.toHaveProperty("markdownContent");
  });

  test("drafts fans out over types and keeps only status=draft", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(TYPES) // /types
      .mockResolvedValueOnce([
        { documentId: 38, status: "active", markdownContent: "X" },
        { documentId: 50, status: "draft", version: "3.0", markdownContent: "Y" },
      ]) // /TOS/versions
      .mockResolvedValueOnce([{ documentId: 41, status: "active", markdownContent: "Z" }]); // /GLOBAL/versions
    const out = await runLegalDrafts(c);
    expect(c.get).toHaveBeenNthCalledWith(1, "/api/legal-documents/types");
    expect(c.get).toHaveBeenNthCalledWith(2, "/api/legal-documents/TOS/versions");
    expect(c.get).toHaveBeenNthCalledWith(3, "/api/legal-documents/GLOBAL/versions");
    expect(out.count).toBe(1);
    expect(out.items[0]).toMatchObject({ documentId: 50, status: "draft", version: "3.0" });
    expect(out.items[0]).not.toHaveProperty("markdownContent");
  });

  test("diff (two ids) gets both docs, strips content, returns line counts", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ documentId: 4, typeName: "TOS", status: "archived", markdownContent: "a\nb\nc" })
      .mockResolvedValueOnce({ documentId: 38, typeName: "TOS", status: "active", markdownContent: "a\nB\nc\nd" });
    const out = await runLegalDiff(c, { a: 4, b: 38 });
    expect(c.get).toHaveBeenNthCalledWith(1, "/api/legal-documents/document/4");
    expect(c.get).toHaveBeenNthCalledWith(2, "/api/legal-documents/document/38");
    expect(out.a).toMatchObject({ documentId: 4, contentLength: 5 });
    expect(out.a).not.toHaveProperty("markdownContent");
    expect(out.sameContent).toBe(false);
    expect(out.addedLines).toBe(2); // "B" and "d"
    expect(out.removedLines).toBe(1); // "b"
  });

  test("diff --type resolves active (old) vs newest draft (new)", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { documentId: 50, status: "draft" },
        { documentId: 38, status: "active" },
        { documentId: 4, status: "archived" },
      ]) // /TOS/versions
      .mockResolvedValueOnce({ documentId: 38, markdownContent: "old" }) // active = a
      .mockResolvedValueOnce({ documentId: 50, markdownContent: "new" }); // draft = b
    const out = await runLegalDiff(c, { type: "TOS" });
    expect(c.get).toHaveBeenNthCalledWith(1, "/api/legal-documents/TOS/versions");
    expect(c.get).toHaveBeenNthCalledWith(2, "/api/legal-documents/document/38");
    expect(c.get).toHaveBeenNthCalledWith(3, "/api/legal-documents/document/50");
    expect(out.a).toMatchObject({ documentId: 38 });
    expect(out.b).toMatchObject({ documentId: 50 });
  });

  test("diff --type with owner scopes the version lookup to that tenant", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { documentId: 70, status: "draft" },
        { documentId: 36, status: "active" },
      ]) // /BETONIJERRY_TOS/versions?ownerAsiakasId=1349
      .mockResolvedValueOnce({ documentId: 36, markdownContent: "old" })
      .mockResolvedValueOnce({ documentId: 70, markdownContent: "new" });
    await runLegalDiff(c, { type: "BETONIJERRY_TOS", owner: 1349 });
    expect(c.get).toHaveBeenNthCalledWith(
      1,
      "/api/legal-documents/BETONIJERRY_TOS/versions?ownerAsiakasId=1349"
    );
  });

  test("diff --type with no draft -> exit 5", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ documentId: 38, status: "active" }]);
    await expect(runLegalDiff(c, { type: "TOS" })).rejects.toMatchObject({ exitCode: 5 });
  });

  test("diff --type with no active -> exit 5", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ documentId: 50, status: "draft" }]);
    await expect(runLegalDiff(c, { type: "TOS" })).rejects.toMatchObject({ exitCode: 5 });
  });

  test("get fetches one document by id", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({ documentId: 9 });
    await runLegalGet(c, 9);
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/document/9");
  });

  // feedback #231: `ib legal list` keys rows by typeName, so `ib legal get
  // PRIVACY` must resolve the type's current ACTIVE document instead of exit 4.
  test("get with a typeName resolves via /current/:typeName", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({ documentId: 12, typeName: "PRIVACY" });
    const out = await runLegalGet(c, "PRIVACY");
    expect(c.get).toHaveBeenCalledWith("/api/legal-documents/current/PRIVACY");
    expect(out).toEqual({ documentId: 12, typeName: "PRIVACY" });
  });

  test("get with a typeName and no active doc -> exit 5 with versions hint", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockRejectedValue(new CliError("Asiakirjaa ei löytynyt.", 404, null, 5));
    await expect(runLegalGet(c, "COOKIES")).rejects.toMatchObject({
      exitCode: 5,
      message: expect.stringContaining('no active document of type "COOKIES"'),
      hint: expect.stringContaining("ib legal versions COOKIES"),
    });
  });

  test("get with a typeName rethrows non-404 errors untouched", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockRejectedValue(new CliError("boom", 500, null, 6));
    await expect(runLegalGet(c, "TOS")).rejects.toMatchObject({ exitCode: 6, message: "boom" });
  });

  test("parseLegalGetRef classifies digits as documentId", () => {
    expect(parseLegalGetRef("42")).toBe(42);
    expect(parseLegalGetRef(" 7 ")).toBe(7);
  });

  test("parseLegalGetRef classifies UPPER_SNAKE as typeName, uppercasing input", () => {
    expect(parseLegalGetRef("PRIVACY")).toBe("PRIVACY");
    expect(parseLegalGetRef("privacy")).toBe("PRIVACY");
    expect(parseLegalGetRef("BETONIJERRY_TOS")).toBe("BETONIJERRY_TOS");
  });

  test("parseLegalGetRef rejects anything else with a dual remedy (exit 4)", () => {
    const errorOf = (fn: () => void): CliError | undefined => {
      try {
        fn();
        return undefined;
      } catch (e) {
        return e as CliError;
      }
    };
    for (const bad of ["5.5", "TOS-1", "-3", "1e3", ""]) {
      const e = errorOf(() => parseLegalGetRef(bad));
      expect(e?.exitCode).toBe(4);
      expect(e?.message).toMatch(/ib legal list/);
      expect(e?.message).toMatch(/ib legal types/);
    }
    // All-digits input is unambiguously a documentId attempt → parseId's
    // canonical-integer guard fires, not the dual remedy.
    const zero = errorOf(() => parseLegalGetRef("0"));
    expect(zero?.exitCode).toBe(4);
    expect(zero?.message).toMatch(/expected a positive integer/);
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
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual({ personId: 5, acceptedVersion: "1.0" });
  });

  test("acceptances emits truncated:false as a present boolean (not undefined)", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      typeName: "TOS", personSettingTypeId: 40, count: 1, truncated: false,
      acceptances: [{ personId: 5, acceptedVersion: "1.0" }],
    });
    const out = await runLegalAcceptances(c, "TOS", {});
    expect(out.truncated).toBe(false);
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

describe("resolveTypeNameTarget (accept dual-target, feedback #32)", () => {
  test("positional alone resolves", () => {
    expect(resolveTypeNameTarget("TOS", undefined)).toBe("TOS");
  });
  test("--type alone resolves", () => {
    expect(resolveTypeNameTarget(undefined, "TOS")).toBe("TOS");
  });
  test("both agreeing resolves", () => {
    expect(resolveTypeNameTarget("TOS", "TOS")).toBe("TOS");
  });
  test("neither -> exit 4", () => {
    expect(() => resolveTypeNameTarget(undefined, undefined)).toThrowError(
      expect.objectContaining({ exitCode: 4 })
    );
  });
  test("both differing -> exit 4", () => {
    expect(() => resolveTypeNameTarget("TOS", "EULA")).toThrowError(
      expect.objectContaining({ exitCode: 4 })
    );
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

describe("ib legal type writes (feedback #31)", () => {
  test("type create POSTs typeName + provided fields with write headers", async () => {
    const c = mockClient();
    const row = { documentTypeId: 8, typeName: "TOS_EN" };
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    const out = await runLegalTypeCreate(
      c,
      "TOS_EN",
      { displayName: "Terms of Service", personSettingTypeId: 45 },
      { reason: "publish EN docs" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/legal-documents/types",
      { typeName: "TOS_EN", displayName: "Terms of Service", personSettingTypeId: 45 },
      { headers: { "X-Action-Reason": "publish EN docs" } }
    );
    expect(out).toEqual(row);
  });

  test("type create with only required fields sends a minimal body", async () => {
    const c = mockClient();
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValue({ documentTypeId: 9 });
    await runLegalTypeCreate(c, "AUP_FI", { displayName: "Hyvaksyttavan kayton periaatteet" }, { dryRun: true });
    expect(c.post).toHaveBeenCalledWith(
      "/api/legal-documents/types",
      { typeName: "AUP_FI", displayName: "Hyvaksyttavan kayton periaatteet" },
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("type update PUTs only provided fields with dry-run header", async () => {
    const c = mockClient();
    (c.put as ReturnType<typeof vi.fn>).mockResolvedValue({ documentTypeId: 5, personSettingTypeId: 44 });
    await runLegalTypeUpdate(c, "GLOBAL", { personSettingTypeId: 44 }, { dryRun: true });
    expect(c.put).toHaveBeenCalledWith(
      "/api/legal-documents/types/GLOBAL",
      { personSettingTypeId: 44 },
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("type update with no fields -> exit 4, no PUT", async () => {
    const c = mockClient();
    await expect(runLegalTypeUpdate(c, "GLOBAL", {}, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(c.put).not.toHaveBeenCalled();
  });

  test("pickTypeFields maps settingTypeId -> personSettingTypeId, drops undefined", () => {
    expect(pickTypeFields({ settingTypeId: 44, displayName: undefined })).toEqual({
      personSettingTypeId: 44,
    });
    expect(pickTypeFields({})).toEqual({});
  });
});

describe("ib legal list alias (#3)", () => {
  test("`active` is also reachable as `list`", () => {
    const program = buildProgram();
    const legal = program.commands.find((c) => c.name() === "legal");
    expect(legal).toBeDefined();
    const active = legal!.commands.find((c) => c.name() === "active");
    expect(active).toBeDefined();
    expect(active!.aliases()).toContain("list");
  });
});

describe("ib legal save — edit mode (in-field partial)", () => {
  const ACTIVE = {
    documentId: 7, typeName: "TOS", version: "2.0", title: "Käyttöehdot",
    markdownContent: "# TOS\n\nMaksuaika on 14 vrk.\n",
  };

  test("--replace --dry-run returns a field diff and never POSTs", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue(ACTIVE);
    const out = await runLegalSaveWithEdit(
      c, "TOS",
      { kind: "replace", find: "14 vrk", replacement: "30 vrk" },
      { version: "2.1" },
      { dryRun: true }
    ) as Record<string, unknown>;
    expect(c.post).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dryRun: true, type: "TOS", field: "markdownContent", matchCount: 1 });
    expect(String(out.unified)).toContain("- Maksuaika on 14 vrk.");
    expect(String(out.unified)).toContain("+ Maksuaika on 30 vrk.");
  });

  test("real edit saves a NEW version with the merged content; title defaults to current", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.includes("/current/")
        ? Promise.resolve(ACTIVE)
        : Promise.resolve(TYPES) // resolveDocumentType inside runLegalSave
    );
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValue({ documentId: 8, success: true });
    await runLegalSaveWithEdit(
      c, "TOS",
      { kind: "append", text: "\n\n## Liite\nUusi kohta." },
      { version: "2.1" }, // no title → defaults to ACTIVE.title
      { reason: "add appendix" }
    );
    const [path, body] = (c.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe("/api/legal-documents/save");
    expect(body).toMatchObject({ version: "2.1", title: "Käyttöehdot" });
    expect(String((body as Record<string, unknown>).markdownContent)).toContain("## Liite");
  });

  test("no active version → exit 5", async () => {
    const c = mockClient();
    (c.get as ReturnType<typeof vi.fn>).mockRejectedValue(new CliError("not found", 404, null, 5));
    await expect(
      runLegalSaveWithEdit(c, "TOS", { kind: "append", text: "x" }, { version: "2.1" }, { reason: "r" })
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});
