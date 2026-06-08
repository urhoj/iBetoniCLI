import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runOhjeGet,
  runOhjeList,
  runOhjeUpdate,
  buildOhjeBody,
  buildOhjeFields,
} from "../../src/commands/ohje/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const asGet = () => mockClient.get as ReturnType<typeof vi.fn>;
const asPut = () => mockClient.put as ReturnType<typeof vi.fn>;

describe("ib ohje get/list", () => {
  beforeEach(() => {
    asGet().mockReset();
  });

  test("runOhjeGet returns the first row of the recordset", async () => {
    asGet().mockResolvedValueOnce([
      { helpId: "X", title: "T", htmltext: "<p>h</p>", shorttext: "s", img: null },
    ]);
    const row = await runOhjeGet(mockClient, "X");
    expect(mockClient.get).toHaveBeenCalledWith("/api/helps/get/X");
    expect(row?.title).toBe("T");
  });

  test("runOhjeGet returns null for an unknown helpId (empty recordset)", async () => {
    asGet().mockResolvedValueOnce([]);
    expect(await runOhjeGet(mockClient, "Nope")).toBeNull();
  });

  test("runOhjeGet url-encodes the helpId", async () => {
    asGet().mockResolvedValueOnce([]);
    await runOhjeGet(mockClient, "a b");
    expect(mockClient.get).toHaveBeenCalledWith("/api/helps/get/a%20b");
  });

  test("runOhjeList wraps rows in the universal list envelope", async () => {
    asGet().mockResolvedValueOnce([{ helpId: "A" }, { helpId: "B" }]);
    const res = await runOhjeList(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/helps/getAll");
    expect(res).toEqual({
      items: [{ helpId: "A" }, { helpId: "B" }],
      nextCursor: null,
      count: 2,
    });
  });
});

describe("buildOhjeBody (GET-merge so omitted fields survive)", () => {
  test("preserves current fields, overrides only what is provided", () => {
    const current = {
      helpId: "X",
      title: "Old",
      shorttext: "os",
      htmltext: "<p>old</p>",
      img: "i.png",
    };
    expect(buildOhjeBody(current, "X", { title: "New" })).toEqual({
      helpId: "X",
      title: "New",
      shorttext: "os",
      htmltext: "<p>old</p>",
      img: "i.png",
    });
  });

  test("fills empty strings / null when there is no current row (new entry)", () => {
    expect(buildOhjeBody(null, "New", { title: "T" })).toEqual({
      helpId: "New",
      title: "T",
      shorttext: "",
      htmltext: "",
      img: null,
    });
  });

  test("does NOT echo extra GET columns back into the PUT body", () => {
    const current = {
      helpId: "X",
      title: "T",
      shorttext: "s",
      htmltext: "<p>h</p>",
      img: null,
      rev: 7,
      accessCount: 99,
      entryTime: "2020-01-01",
    };
    expect(buildOhjeBody(current, "X", {})).toEqual({
      helpId: "X",
      title: "T",
      shorttext: "s",
      htmltext: "<p>h</p>",
      img: null,
    });
  });

  test("explicit null img clears it; undefined img preserves the current value", () => {
    const current = { helpId: "X", title: "T", shorttext: "", htmltext: "", img: "old.png" };
    expect(buildOhjeBody(current, "X", { img: null }).img).toBeNull();
    expect(buildOhjeBody(current, "X", {}).img).toBe("old.png");
  });
});

describe("buildOhjeFields (typed flags win over --body; --img \"\" clears)", () => {
  test("typed flags override matching --body keys", () => {
    expect(
      buildOhjeFields({ body: '{"title":"B","htmltext":"<p>b</p>"}', title: "A" })
    ).toEqual({ title: "A", shorttext: undefined, htmltext: "<p>b</p>", img: undefined });
  });

  test("--img \"\" coerces to null (clear); a real value passes through", () => {
    expect(buildOhjeFields({ img: "" }).img).toBeNull();
    expect(buildOhjeFields({ img: "logo.png" }).img).toBe("logo.png");
  });

  test("--body '{\"img\":null}' passes null through", () => {
    expect(buildOhjeFields({ body: '{"img":null}' }).img).toBeNull();
  });
});

describe("ib ohje update", () => {
  beforeEach(() => {
    asGet().mockReset();
    asPut().mockReset();
  });

  test("--dry-run previews the merged row WITHOUT writing", async () => {
    asGet().mockResolvedValueOnce([
      { helpId: "X", title: "Old", shorttext: "s", htmltext: "<p>o</p>", img: null },
    ]);
    const res = await runOhjeUpdate(
      mockClient,
      "X",
      { title: "New" },
      { dryRun: true, reason: "r" }
    );
    expect(mockClient.put).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      dryRun: true,
      helpId: "X",
      proposed: { helpId: "X", title: "New", htmltext: "<p>o</p>" },
    });
  });

  test("a real write GET-merges then PUTs the full row with the reason header", async () => {
    asGet().mockResolvedValueOnce([
      { helpId: "X", title: "Old", shorttext: "s", htmltext: "<p>o</p>", img: null },
    ]);
    asPut().mockResolvedValueOnce({ success: true, message: "ok" });
    const res = await runOhjeUpdate(
      mockClient,
      "X",
      { htmltext: "<p>new</p>" },
      { reason: "content fix" }
    );
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/helps/update",
      { helpId: "X", title: "Old", shorttext: "s", htmltext: "<p>new</p>", img: null },
      { headers: { "X-Action-Reason": "content fix" } }
    );
    expect(res).toEqual({ success: true, message: "ok" });
  });
});
