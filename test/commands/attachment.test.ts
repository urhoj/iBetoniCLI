import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAttachmentList,
  runAttachmentGet,
  runAttachmentTypes,
  runAttachmentSearch,
  resolveEntityTarget,
  mimeFromExtension,
  resolveGroupAndType,
  runAttachmentUploadUrl,
  runAttachmentRegister,
  runAttachmentUpload,
  runAttachmentDownload,
} from "../../src/commands/attachment/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const c = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const LIST = { items: [], nextCursor: null, count: 0 };

describe("ib attachment reads", () => {
  beforeEach(() => vi.clearAllMocks());

  test("list builds entity query", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runAttachmentList(c, { entity: "keikka", entityId: 9001 }, {});
    expect(c.get).toHaveBeenCalledWith("/api/cli/attachment/list?entity=keikka&id=9001");
  });

  test("list passes resolved numeric group/type + limit", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runAttachmentList(c, { entity: "vehicle", entityId: 53 }, { groupId: 1, typeId: 7, limit: 10 });
    expect(c.get).toHaveBeenCalledWith("/api/cli/attachment/list?entity=vehicle&id=53&group=1&type=7&limit=10");
  });

  test("get hits get/:id", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ attachmentId: 4711 });
    await runAttachmentGet(c, 4711);
    expect(c.get).toHaveBeenCalledWith("/api/cli/attachment/get/4711");
  });

  test("types hits /types", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ groups: [], types: [] });
    await runAttachmentTypes(c);
    expect(c.get).toHaveBeenCalledWith("/api/cli/attachment/types");
  });

  test("search encodes q and missing", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runAttachmentSearch(c, { q: "kuormakirja äö" });
    expect(c.get).toHaveBeenCalledWith(
      `/api/cli/attachment/search?q=${encodeURIComponent("kuormakirja äö")}`
    );
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST);
    await runAttachmentSearch(c, { missing: true });
    expect(c.get).toHaveBeenCalledWith("/api/cli/attachment/search?missing=1");
  });
});

describe("resolveEntityTarget", () => {
  test("maps each flag to its wire entity", () => {
    expect(resolveEntityTarget({ keikka: 9001 })).toEqual({ entity: "keikka", entityId: 9001 });
    expect(resolveEntityTarget({ customer: 8 })).toEqual({ entity: "customer", entityId: 8 });
    expect(resolveEntityTarget({ bugReport: 3 })).toEqual({ entity: "bugReport", entityId: 3 });
    expect(resolveEntityTarget({ offer: 567 })).toEqual({ entity: "offer", entityId: 567 });
  });

  test("throws exit-4 CliError on zero or two entity flags", () => {
    expect(() => resolveEntityTarget({})).toThrowError(CliError);
    expect(() => resolveEntityTarget({ keikka: 1, vehicle: 2 })).toThrowError(CliError);
  });
});

describe("mimeFromExtension", () => {
  test("known + fallback", () => {
    expect(mimeFromExtension("a.JPG")).toBe("image/jpeg");
    expect(mimeFromExtension("b.pdf")).toBe("application/pdf");
    expect(mimeFromExtension("c.unknownext")).toBe("application/octet-stream");
  });
});

describe("resolveGroupAndType", () => {
  beforeEach(() => vi.clearAllMocks());

  test("passes numeric ids through without fetching", async () => {
    const out = await resolveGroupAndType(c, { group: "1", type: "7" });
    expect(out).toEqual({ groupId: 1, typeId: 7 });
    expect(c.get).not.toHaveBeenCalled();
  });

  test("resolves names to ids with a single /types fetch", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      groups: [{ attachmentGroupId: 1, attachmentGroupName: "Tilaus" }],
      types: [{ attachmentTypeId: 7, attachmentTypeName: "Kuva" }],
    });
    const out = await resolveGroupAndType(c, { group: "tilaus", type: "kuva" });
    expect(out).toEqual({ groupId: 1, typeId: 7 });
    expect(c.get).toHaveBeenCalledTimes(1); // memoized — not two /types calls
  });

  test("unknown name throws exit-4 CliError", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      groups: [{ attachmentGroupId: 1, attachmentGroupName: "Tilaus" }],
      types: [],
    });
    await expect(resolveGroupAndType(c, { group: "nope" })).rejects.toThrowError(CliError);
  });
});

describe("ib attachment upload/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test("upload-url posts the bare name", async () => {
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ uploadUrl: "u", fileFolder: "8/2026", fileName: "x.jpg" });
    await runAttachmentUploadUrl(c, "site.jpg");
    expect(c.post).toHaveBeenCalledWith("/api/cli/attachment/upload-url", { name: "site.jpg" });
  });

  test("register posts metadata with write-flag headers", async () => {
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, attachmentId: 4711 });
    await runAttachmentRegister(
      c,
      { fileName: "x.jpg", origFileName: "site.jpg", fileFolder: "8/2026", fileType: "image/jpeg", fileSize: 3, entity: "keikka", entityId: 9001, fileComment: "k" },
      { reason: "test" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/attachment/register",
      expect.objectContaining({ fileName: "x.jpg", entity: "keikka", entityId: 9001 }),
      { headers: { "X-Action-Reason": "test" } }
    );
  });

  test("upload chains mint → PUT (BlockBlob header) → register", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-att-"));
    const file = join(dir, "photo.jpg");
    await fsWriteFile(file, Buffer.from([1, 2, 3]));
    (c.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ uploadUrl: "https://blob/up?sas=1", fileFolder: "8/2026", fileName: "uuid.jpg" })
      .mockResolvedValueOnce({ ok: true, attachmentId: 4711 });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runAttachmentUpload(c, file, { keikka: 9001 }, {});

    expect(fetchMock).toHaveBeenCalledWith("https://blob/up?sas=1", {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob" },
      body: expect.anything(),
    });
    expect(c.post).toHaveBeenLastCalledWith(
      "/api/cli/attachment/register",
      expect.objectContaining({
        fileName: "uuid.jpg", origFileName: "photo.jpg", fileFolder: "8/2026",
        fileType: "image/jpeg", fileSize: 3, entity: "keikka", entityId: 9001,
      }),
      { headers: {} }
    );
    expect(result).toMatchObject({ ok: true, attachmentId: 4711 });
  });

  test("upload --dry-run makes zero network calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-att-"));
    const file = join(dir, "photo.jpg");
    await fsWriteFile(file, Buffer.from([1, 2, 3]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = (await runAttachmentUpload(c, file, { keikka: 9001 }, { dryRun: true })) as Record<string, unknown>;
    expect(result.dryRun).toBe(true);
    expect(c.post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("PUT failure does NOT register metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-att-"));
    const file = join(dir, "photo.jpg");
    await fsWriteFile(file, Buffer.from([1]));
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ uploadUrl: "u", fileFolder: "8/2026", fileName: "x.jpg" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(runAttachmentUpload(c, file, { keikka: 9001 }, {})).rejects.toThrowError(CliError);
    expect(c.post).toHaveBeenCalledTimes(1); // mint only, no register
  });

  test("download fetches blobUrl and writes the file; refuses overwrite without force", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-att-"));
    const out = join(dir, "saved.jpg");
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      attachmentId: 4711, origFileName: "site.jpg", fileType: "image/jpeg",
      blobUrl: "https://blob/x?sas=1",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([9, 9]).buffer,
    }));
    const result = (await runAttachmentDownload(c, 4711, out, false)) as Record<string, unknown>;
    expect(result.bytes).toBe(2);
    expect(Buffer.from(await fsReadFile(out))).toEqual(Buffer.from([9, 9]));
    // second run without --force refuses (exit 4)
    await expect(runAttachmentDownload(c, 4711, out, false)).rejects.toThrowError(CliError);
    // with force succeeds
    await expect(runAttachmentDownload(c, 4711, out, true)).resolves.toBeTruthy();
  });

  test("download basenames a traversal origFileName into cwd (no --out)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-att-cwd-"));
    const prevCwd = process.cwd();
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      attachmentId: 4711, origFileName: "../../evil.jpg", fileType: "image/jpeg",
      blobUrl: "https://blob/x?sas=1",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, arrayBuffer: async () => Uint8Array.from([5]).buffer,
    }));
    try {
      process.chdir(dir);
      const result = (await runAttachmentDownload(c, 4711, undefined, false)) as Record<string, unknown>;
      expect(String(result.file).endsWith("evil.jpg")).toBe(true);
      expect(String(result.file)).not.toContain("..");
      expect(await fsReadFile(join(dir, "evil.jpg"))).toBeTruthy();
    } finally {
      process.chdir(prevCwd);
    }
  });
});
