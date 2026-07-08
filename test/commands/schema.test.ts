import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSchemaTables,
  runSchemaTable,
  runSchemaViews,
  runSchemaView,
  runSchemaProcs,
  runSchemaProc,
  runSchemaDump,
  runSchemaBatch,
} from "../../src/commands/schema/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const get = () => mockClient.get as ReturnType<typeof vi.fn>;

describe("ib schema", () => {
  beforeEach(() => {
    get().mockReset();
  });

  test("runSchemaTables: bare path when no opts", async () => {
    get().mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runSchemaTables(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/schema/tables");
  });

  test("runSchemaTables: search + limit query string", async () => {
    get().mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runSchemaTables(mockClient, { search: "keik", limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/tables?search=keik&limit=50"
    );
  });

  test("runSchemaTables: limit-only query string (no search key)", async () => {
    get().mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runSchemaTables(mockClient, { limit: 100 });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/tables?limit=100"
    );
  });

  test("runSchemaTable: GET /api/cli/schema/table/<name>", async () => {
    get().mockResolvedValueOnce({ name: "keikka" });
    const r = (await runSchemaTable(mockClient, "keikka")) as { name: string };
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/schema/table/keikka");
    expect(r.name).toBe("keikka");
  });

  test("runSchemaViews / runSchemaView", async () => {
    get().mockResolvedValue({ items: [], nextCursor: null, count: 0 });
    await runSchemaViews(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/schema/views");
    await runSchemaView(mockClient, "keikkaBetoniView");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/view/keikkaBetoniView"
    );
  });

  test("runSchemaProcs / runSchemaProc", async () => {
    get().mockResolvedValue({ items: [], nextCursor: null, count: 0 });
    await runSchemaProcs(mockClient, { search: "asiakas" });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/procs?search=asiakas"
    );
    await runSchemaProc(mockClient, "asiakas_find");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/proc/asiakas_find"
    );
  });

  test("runSchemaDump: GET /api/cli/schema/dump", async () => {
    get().mockResolvedValueOnce({ tables: [], foreignKeys: [], views: [], procs: [] });
    await runSchemaDump(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/schema/dump");
  });

  test("runSchemaBatch: fans out the single fn per name into an envelope", async () => {
    get()
      .mockResolvedValueOnce({ name: "sijainti_save" })
      .mockResolvedValueOnce({ name: "sijainti_add" });
    const res = await runSchemaBatch(mockClient, runSchemaProc, ["sijainti_save", "sijainti_add"]);
    expect(mockClient.get).toHaveBeenNthCalledWith(1, "/api/cli/schema/proc/sijainti_save");
    expect(mockClient.get).toHaveBeenNthCalledWith(2, "/api/cli/schema/proc/sijainti_add");
    expect(res).toEqual({
      items: [
        { name: "sijainti_save", found: true, object: { name: "sijainti_save" } },
        { name: "sijainti_add", found: true, object: { name: "sijainti_add" } },
      ],
      nextCursor: null,
      count: 2,
    });
  });

  test("runSchemaBatch: a 404 becomes found:false without throwing", async () => {
    get()
      .mockResolvedValueOnce({ name: "keikka" })
      .mockRejectedValueOnce(new CliError("Table not found", 404, {}, 5));
    const res = await runSchemaBatch(mockClient, runSchemaTable, ["keikka", "nope"]);
    expect(res.items).toEqual([
      { name: "keikka", found: true, object: { name: "keikka" } },
      { name: "nope", found: false, object: null },
    ]);
    expect(res.count).toBe(2);
  });

  test("runSchemaBatch: a non-404 error rejects the batch", async () => {
    get()
      .mockResolvedValueOnce({ name: "keikka" })
      .mockRejectedValueOnce(new CliError("Backend error", 500, {}, 6));
    await expect(
      runSchemaBatch(mockClient, runSchemaTable, ["keikka", "boom"])
    ).rejects.toBeInstanceOf(CliError);
  });
});
