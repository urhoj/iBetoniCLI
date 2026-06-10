import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runAttachmentList,
  runAttachmentGet,
  runAttachmentTypes,
  runAttachmentSearch,
  resolveEntityTarget,
  mimeFromExtension,
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
