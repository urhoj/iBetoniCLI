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
  runSchemaQuery,
  runSchemaIndexes,
  resolveSqlInput,
  declaredObjectName,
  parseParamLiteral,
  resolveQueryParams,
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

  test("runSchemaIndexes: bare path when no opts", async () => {
    get().mockResolvedValueOnce({ statsSince: "2026-08-09T04:39:19.553Z", items: [], nextCursor: null, count: 0 });
    await runSchemaIndexes(mockClient, {});
    expect(get()).toHaveBeenCalledWith("/api/cli/schema/indexes");
  });

  test("runSchemaIndexes: table + search + limit + unused query string", async () => {
    get().mockResolvedValueOnce({ statsSince: null, items: [], nextCursor: null, count: 0 });
    await runSchemaIndexes(mockClient, { table: "keikka", search: "pvm", limit: 50, unused: true });
    expect(get()).toHaveBeenCalledWith("/api/cli/schema/indexes?table=keikka&search=pvm&limit=50&unused=1");
  });

  // Pins the `? 1 : undefined` ternary in listQuery: `unused: opts.unused`
  // would emit `unused=false`, which the route parses as falsy TODAY but a
  // stricter future parse would read as the filter being ON.
  test("runSchemaIndexes: unused=false is dropped from the query string", async () => {
    get().mockResolvedValueOnce({ statsSince: null, items: [], nextCursor: null, count: 0 });
    await runSchemaIndexes(mockClient, { unused: false });
    expect(get()).toHaveBeenCalledWith("/api/cli/schema/indexes");
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
      ["indexes", runSchemaIndexes, "ib dev schema indexes"],
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

  /**
   * fb#438 — ad-hoc read-only SQL. The wire contract that matters here is the
   * `{ read: true }` marker: without it the command would be refused under
   * `--read-only` and would print the acting-as WRITE banner for a read.
   */
  describe("runSchemaQuery (fb#438)", () => {
    const post = () => mockClient.post;
    let warned: string[];
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      post().mockReset();
      warned = [];
      spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        warned.push(String(chunk));
        return true;
      });
    });
    afterEach(() => spy.mockRestore());

    const complete = { columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false, cap: 1000 };

    test("POSTs the sql as a read-over-POST and returns the payload untouched", async () => {
      post().mockResolvedValueOnce(complete);
      const sql = "SELECT COUNT(*) AS n FROM keikka";
      const result = await runSchemaQuery(mockClient, sql);
      expect(mockClient.post).toHaveBeenCalledWith("/api/cli/schema/query", { sql }, { read: true });
      expect(result).toEqual(complete);
      expect(warned.join("")).toBe("");
    });

    test("a capped result warns on stderr, names the command, and steers to aggregation", async () => {
      post().mockResolvedValueOnce({ columns: ["a"], rows: [{ a: 1 }], rowCount: 1000, truncated: true, cap: 1000 });
      const result = await runSchemaQuery(mockClient, "SELECT * FROM keikka");
      expect(result.truncated).toBe(true);
      const msg = warned.join("");
      expect(msg).toContain("TRUNCATED");
      expect(msg).toContain("ib dev schema query");
      expect(msg).toContain("GROUP BY");
    });

    /**
     * fb#1326 — this command runs on the db_datareader-only `ib_readonly`
     * login, so the routine-bearing catalogs come back near-empty with NO
     * error: sys.procedures returns 6 rows against 512 dbo procs. A caller
     * reading that as "the proc does not exist" is the failure this prevents.
     */
    describe("metadata-filtered catalog hint (fb#1326)", () => {
      test("a sys.procedures read is flagged, naming the login and the command that can settle existence", async () => {
        post().mockResolvedValueOnce({ ...complete, rows: [{ n: 6 }] });
        const result = await runSchemaQuery(mockClient, "SELECT COUNT(*) AS n FROM sys.procedures");
        expect(result.hint).toContain("ib_readonly");
        expect(result.hint).toContain("ib dev schema procs|proc|table|view");
      });

      test.each([
        // The original fb#1326 trap: listed tables, keys and triggers, no procs.
        ["sys.objects", "SELECT name FROM sys.objects WHERE name LIKE '%eikkaPerson%'"],
        // Lower-cased on purpose — the matcher is case-insensitive.
        ["INFORMATION_SCHEMA.ROUTINES", "select * from information_schema.routines"],
        ["sys.parameters", "SELECT * FROM sys.parameters WHERE object_id = 1"],
        ["sys.sql_modules", "SELECT definition FROM sys.sql_modules"],
      ])("%s is flagged", async (_label, sql) => {
        post().mockResolvedValueOnce(complete);
        const result = await runSchemaQuery(mockClient, sql);
        expect(result.hint).toBeDefined();
      });

      /**
       * The cry-wolf guard. These catalogs were MEASURED complete under this
       * login (db_datareader implies metadata visibility on the tables it can
       * read), so warning on them would be substantively false — and a warning
       * that is false on correct queries is one callers learn to ignore.
       */
      test.each([
        ["sys.tables", "SELECT COUNT(*) AS n FROM sys.tables"],
        ["sys.columns", "SELECT name FROM sys.columns WHERE object_id = 1"],
        ["INFORMATION_SCHEMA.TABLES", "SELECT * FROM INFORMATION_SCHEMA.TABLES"],
        ["a plain user table", "SELECT COUNT(*) AS n FROM keikka"],
      ])("%s is NOT flagged", async (_label, sql) => {
        post().mockResolvedValueOnce(complete);
        const result = await runSchemaQuery(mockClient, sql);
        // Absent, not undefined: stdout key order is part of the contract.
        expect("hint" in result).toBe(false);
        expect(result).toEqual(complete);
      });
    });
  });

  describe("resolveSqlInput (fb#968)", () => {
    test("accepts the positional alone", () => {
      expect(resolveSqlInput("SELECT 1", undefined)).toBe("SELECT 1");
    });

    test("accepts --sql alone", () => {
      expect(resolveSqlInput(undefined, "SELECT 1")).toBe("SELECT 1");
    });

    test("agreeing positional and --sql are fine", () => {
      expect(resolveSqlInput("SELECT 1", "SELECT 1")).toBe("SELECT 1");
    });

    test("conflicting positional and --sql exit 4", () => {
      expect(() => resolveSqlInput("SELECT 1", "SELECT 2")).toThrow(/must match/);
    });

    test("neither given exits 4", () => {
      expect(() => resolveSqlInput(undefined, undefined)).toThrow(/--sql.*required/);
    });

    test("treats whitespace-only as absent", () => {
      expect(() => resolveSqlInput("   ", undefined)).toThrow(/required/);
    });
  });

  /**
   * fb#1177 — without binding, an application query pasted verbatim failed with
   * "Must declare the scalar variable" and every @param had to be hand-edited
   * into a literal: the exact edit that can change the predicate being verified.
   */
  describe("query parameters (fb#1177)", () => {
    const post = () => mockClient.post;
    const complete = { columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false, cap: 1000 };
    beforeEach(() => post().mockReset());

    describe("parseParamLiteral", () => {
      test.each([
        ["an integer", "8", 8],
        ["zero", "0", 0],
        ["a negative", "-3", -3],
        ["a decimal", "60.25", 60.25],
        ["true", "true", true],
        ["false", "false", false],
        // THE case the typing exists for: bound as the string "null" it would
        // answer `@x IS NULL OR col = @x` with the wrong branch.
        ["null", "null", null],
        ["a plain word", "Kalle", "Kalle"],
        ["a date (NOT a number)", "2026-09-06", "2026-09-06"],
        ["an empty value", "", ""],
        ["a leading-zero code (stays a string)", "007", "007"],
        ["a number with spaces around it", " 8 ", " 8 "],
      ])("%s", (_label, raw, expected) => {
        expect(parseParamLiteral(raw)).toEqual(expected);
      });
    });

    test("absent on both spellings → undefined, so the body is unchanged", () => {
      expect(resolveQueryParams(undefined, undefined)).toBeUndefined();
      expect(resolveQueryParams([], undefined)).toBeUndefined();
    });

    test("repeated --param builds the map", () => {
      expect(resolveQueryParams(["ownerAsiakasId=null", "documentTypeId=3"], undefined)).toEqual({
        ownerAsiakasId: null,
        documentTypeId: 3,
      });
    });

    test("the @ sigil is kept verbatim — the backend strips it", () => {
      expect(resolveQueryParams(["@ownerAsiakasId=8"], undefined)).toEqual({ "@ownerAsiakasId": 8 });
    });

    test("only the FIRST = splits, so a value may contain one", () => {
      expect(resolveQueryParams(["expr=a=b"], undefined)).toEqual({ expr: "a=b" });
    });

    test("--params takes a JSON object with exact types", () => {
      expect(resolveQueryParams(undefined, '{"o":8,"name":"8","flag":false,"n":null}')).toEqual({
        o: 8,
        name: "8",
        flag: false,
        n: null,
      });
    });

    test.each([
      ["a malformed pair (no =)", ["ownerAsiakasId"], /name=value/],
      ["an empty name", ["=8"], /name=value/],
      ["invalid JSON", undefined, /valid JSON/],
    ])("%s exits 4", (_label, pairs, pattern) => {
      const json = pairs ? undefined : "{not json";
      expect(() => resolveQueryParams(pairs as string[] | undefined, json)).toThrow(pattern);
    });

    test.each([
      ["a JSON array", "[1,2]"],
      ["a JSON scalar", "8"],
      ["JSON null", "null"],
    ])("--params with %s exits 4", (_label, json) => {
      expect(() => resolveQueryParams(undefined, json)).toThrow(/JSON OBJECT/);
    });

    test("both spellings at once exits 4 rather than picking a silent winner", () => {
      expect(() => resolveQueryParams(["a=1"], '{"a":2}')).toThrow(/not both/);
    });

    test("runSchemaQuery sends params in the body when bound", async () => {
      post().mockResolvedValueOnce({ ...complete });
      await runSchemaQuery(mockClient, "SELECT 1 WHERE @o IS NULL", { o: null });
      expect(mockClient.post).toHaveBeenCalledWith(
        "/api/cli/schema/query",
        { sql: "SELECT 1 WHERE @o IS NULL", params: { o: null } },
        { read: true }
      );
    });

    test("and omits the key entirely when nothing is bound", async () => {
      post().mockResolvedValueOnce({ ...complete });
      await runSchemaQuery(mockClient, "SELECT 1");
      expect(mockClient.post).toHaveBeenCalledWith(
        "/api/cli/schema/query",
        { sql: "SELECT 1" },
        { read: true }
      );
    });
  });

  /**
   * fb#1140 — OBJECT_DEFINITION keeps the pre-rename CREATE text, so a renamed
   * object answers with a body naming something else entirely. The measured
   * case is real: `keikka_saveContactPerson` returns
   * `CREATE PROCEDURE [dbo].[updateKeikkaPerson]`.
   */
  describe("sp_rename mismatch note (fb#1140)", () => {
    describe("declaredObjectName", () => {
      test.each([
        ["bracketed schema-qualified proc", "CREATE PROCEDURE [dbo].[updateKeikkaPerson]\n AS BEGIN", "updateKeikkaPerson"],
        ["bare PROC abbreviation", "CREATE PROC dbo.foo AS", "foo"],
        ["unqualified name", "CREATE PROCEDURE foo AS", "foo"],
        ["CREATE OR ALTER view", "CREATE OR ALTER VIEW [dbo].[v_keikka] AS SELECT 1", "v_keikka"],
        ["function", "CREATE FUNCTION dbo.fn_calc(@a int) RETURNS int", "fn_calc"],
        ["trigger", "CREATE TRIGGER [dbo].[keikka_ins] ON dbo.keikka", "keikka_ins"],
        ["leading blank lines (the measured shape)", "\n\n\nCREATE PROCEDURE [dbo].[updateKeikkaPerson]", "updateKeikkaPerson"],
        ["leading line comment", "-- legacy\nCREATE PROCEDURE dbo.real_name AS", "real_name"],
        ["leading block comment", "/* banner\n   text */\nCREATE PROCEDURE dbo.real_name AS", "real_name"],
        ["lowercase keywords", "create procedure dbo.real_name as", "real_name"],
      ])("%s", (_label, definition, expected) => {
        expect(declaredObjectName(definition)).toBe(expected);
      });

      /**
       * The anti-cry-wolf case: a comment that TALKS about another CREATE must
       * not be read as the declaration. A false rename note is worse than none
       * — it invents a rename that never happened.
       */
      test("a CREATE named inside a leading comment does not win over the real one", () => {
        expect(
          declaredObjectName("-- replaces CREATE PROCEDURE dbo.old_thing\nCREATE PROCEDURE dbo.new_thing AS")
        ).toBe("new_thing");
      });

      test.each([
        ["a non-string", 42],
        ["an unterminated block comment", "/* never closed\nCREATE PROCEDURE dbo.x AS"],
        ["a body that does not start with CREATE", "SET ANSI_NULLS ON\nCREATE PROCEDURE dbo.x AS"],
        ["an empty string", ""],
      ])("%s parses to null", (_label, definition) => {
        expect(declaredObjectName(definition)).toBeNull();
      });
    });

    test.each([
      ["proc", runSchemaProc],
      ["view", runSchemaView],
      ["trigger", runSchemaTrigger],
    ])("%s: a renamed object explains itself", async (_label, run) => {
      get().mockResolvedValueOnce({
        name: "keikka_saveContactPerson",
        definition: "\n\nCREATE PROCEDURE [dbo].[updateKeikkaPerson]\n AS BEGIN UPDATE dbo.keikka",
      });
      const result = (await run(mockClient, "keikka_saveContactPerson")) as {
        renamedFrom: string;
        hint: string;
      };
      expect(result.renamedFrom).toBe("updateKeikkaPerson");
      expect(result.hint).toContain("sp_renamed");
      expect(result.hint).toContain("keikka_saveContactPerson");
    });

    test("a matching name is left untouched, key ABSENT not null", async () => {
      const payload = { name: "asiakas_find", definition: "CREATE PROCEDURE [dbo].[asiakas_find] AS" };
      get().mockResolvedValueOnce({ ...payload });
      const result = await runSchemaProc(mockClient, "asiakas_find");
      expect("renamedFrom" in result).toBe(false);
      expect("hint" in result).toBe(false);
      expect(result).toEqual(payload);
    });

    test("names differing only in case are the SAME object (SQL Server collation)", async () => {
      get().mockResolvedValueOnce({
        name: "Asiakas_Find",
        definition: "CREATE PROCEDURE [dbo].[asiakas_find] AS",
      });
      const result = await runSchemaProc(mockClient, "Asiakas_Find");
      expect("renamedFrom" in result).toBe(false);
    });

    test("a payload with no parseable definition is passed through", async () => {
      get().mockResolvedValueOnce({ name: "keikka", columns: [] });
      const result = await runSchemaView(mockClient, "keikka");
      expect("renamedFrom" in result).toBe(false);
    });

    test("the batch path annotates each renamed member (fb#109 fan-out)", async () => {
      get()
        .mockResolvedValueOnce({ name: "a_proc", definition: "CREATE PROCEDURE [dbo].[old_a] AS" })
        .mockResolvedValueOnce({ name: "b_proc", definition: "CREATE PROCEDURE [dbo].[b_proc] AS" });
      const res = await runSchemaBatch(mockClient, runSchemaProc, ["a_proc", "b_proc"]);
      const byName = Object.fromEntries(res.items.map((i) => [i.name, i.object as Record<string, unknown>]));
      expect(byName.a_proc.renamedFrom).toBe("old_a");
      expect("renamedFrom" in byName.b_proc).toBe(false);
    });
  });
});
