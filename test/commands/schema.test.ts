import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runSchemaTables,
  runSchemaTable,
  runSchemaViews,
  runSchemaView,
  runSchemaProcs,
  runSchemaProc,
  runSchemaDump,
  runSchemaBatch,
  runSchemaTriggers,
  runSchemaTrigger,
  runSchemaSnapshots,
} from "../../src/commands/schema/index.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = mockApiClient();

const get = () => mockClient.get;

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

  test("runSchemaTriggers: bare path when no opts", async () => {
    get().mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runSchemaTriggers(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/schema/triggers");
  });

  test("runSchemaTriggers: table filter alone", async () => {
    get().mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runSchemaTriggers(mockClient, { table: "keikka" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/schema/triggers?table=keikka");
  });

  test("runSchemaTriggers: table + search + limit query string", async () => {
    get().mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
    await runSchemaTriggers(mockClient, { table: "keikka", search: "ins", limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/triggers?table=keikka&search=ins&limit=50"
    );
  });

  test("runSchemaTrigger: GET /api/cli/schema/trigger/<name>", async () => {
    get().mockResolvedValueOnce({ name: "keikka_after_ins_trig", table: "keikka" });
    const r = (await runSchemaTrigger(mockClient, "keikka_after_ins_trig")) as { table: string };
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/schema/trigger/keikka_after_ins_trig"
    );
    expect(r.table).toBe("keikka");
  });

  test("runSchemaBatch works for triggers too (comma-separated names)", async () => {
    get()
      .mockResolvedValueOnce({ name: "a_trig" })
      .mockRejectedValueOnce(new CliError("Trigger not found", 404, {}, 5));
    const res = await runSchemaBatch(mockClient, runSchemaTrigger, ["a_trig", "nope"]);
    expect(mockClient.get).toHaveBeenNthCalledWith(1, "/api/cli/schema/trigger/a_trig");
    expect(res.items).toEqual([
      { name: "a_trig", found: true, object: { name: "a_trig" } },
      { name: "nope", found: false, object: null },
    ]);
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

  /**
   * fb#641 — the cap must be audible, not just present in the payload.
   *
   * These assert through the REAL run* functions rather than the helper, because
   * the reported failure was a schema list specifically: a caller reading only
   * `items` got 200 of 535 procs with exit 0 and concluded whole proc families
   * did not exist. A unit test of warnIfTruncated alone would still pass if a
   * run* function stopped calling it.
   */
  describe("truncation warning (fb#641)", () => {
    const truncated = { items: [{ name: "a" }], nextCursor: null, count: 200, truncated: true, hint: "capped at 200 rows" };
    let warned: string[];
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warned = [];
      spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        warned.push(String(chunk));
        return true;
      });
    });
    afterEach(() => spy.mockRestore());

    test.each([
      ["procs", runSchemaProcs, "ib dev schema procs"],
      ["tables", runSchemaTables, "ib dev schema tables"],
      ["views", runSchemaViews, "ib dev schema views"],
      ["triggers", runSchemaTriggers, "ib dev schema triggers"],
      ["snapshots", runSchemaSnapshots, "ib dev schema snapshots"],
    ])("%s: a truncated page warns and names its own command", async (_name, run, command) => {
      get().mockResolvedValueOnce(truncated);
      const env = await run(mockClient, {});
      // The payload is unchanged — stdout's contract does not move.
      expect(env.truncated).toBe(true);
      const msg = warned.join("");
      expect(msg).toContain("TRUNCATED");
      expect(msg).toContain(command);
    });

    test("a complete page stays silent", async () => {
      get().mockResolvedValueOnce({ items: [{ name: "a" }], nextCursor: null, count: 1 });
      await runSchemaProcs(mockClient, {});
      expect(warned.join("")).toBe("");
    });
  });
});
