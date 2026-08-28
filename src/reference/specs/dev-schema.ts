// dev-schema specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandError, CommandSpec } from "../../output/help.js";
import { apiErr, limitErr } from "./shared.js";

export const DEV_SCHEMA_SPECS: CommandSpec[] = [

  // ─── schema (13) — developer-only SQL introspection ───────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["developer access (isSystemAdmin or isDeveloper)"];
    /** The `--limit` guard row every capped-list leaf in this group shares (fb#949). */
    const LIMIT_1000_ERR = limitErr("pass a positive integer; max is 1000");
    const devErrors: CommandError[] = [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a developer", "run `ib auth whoami`; if not a developer, `ib auth login` as a developer account (same person re-login won't grant it). Gate is server-side — a new DB flag only applies once --endpoint's backend is redeployed."),
      apiErr(500, "Backend error", "retry with --verbose"),
    ];
    const listFlags = [
      { name: "search", type: "string", description: "Filter object names by substring" },
      {
        name: "limit",
        type: "number",
        default: "200",
        description:
          "Max rows (max 1000). The default CAPS the catalogue — dbo holds ~240 tables and ~535 procs, so a default `procs`/`tables` read is a PARTIAL list; pass --limit 1000 whenever you intend to enumerate.",
      },
    ];
    /** Appended to every schema LIST outputShape — the cap is the trap (fb#641). */
    const truncNote =
      " `truncated: true` (with a `hint` naming the way out) means the row cap bit and this page is NOT the whole catalogue — it also prints a warning on stderr. Never conclude an object does not exist from a truncated page; re-run with --limit 1000 or --search first.";
    const invalidNameErr = apiErr(400, "Invalid name (letters/digits/underscore only)", "use the bare object name, no schema prefix");
    return [
      {
        command: "ib dev schema tables",
        description: "List dbo base tables with column counts. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: listFlags,
        outputShape:
          "{ items: [{ name, type:'table', columnCount }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: [limitErr("pass a positive integer; max is 1000, and the 200 default returns a PARTIAL catalogue (dbo holds ~240 tables) — pass `--limit 1000` whenever you intend to enumerate"), ...devErrors],
        examples: ["ib dev schema tables", "ib dev schema tables --search keikka", "ib dev schema tables --limit 1000"],
      },
      {
        command: "ib dev schema table",
        description: "Columns (type, nullability, default, key), primary key, foreign keys (outbound), inbound references (tables/columns whose FK points AT this table), indexes, and attached triggers for one dbo table — or several at once via a comma-separated list. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, columns:[{name,dataType,maxLength,precision,scale,nullable,default,key}], primaryKey:[…], foreignKeys:[{column,refTable,refColumn,name,disabled?,notTrusted?}], checkConstraints:[{name,column,definition,disabled?,notTrusted?}], inboundForeignKeys:[{refTable,refColumn,column}], indexes:[{name,columns,unique}], triggers:[{name,timing,events,disabled}] }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false). precision/scale are null for non-numeric types (varchar → maxLength); a DECIMAL(5,2) reports precision 5 / scale 2, an int precision 10 / scale 0. `triggers` is a SUMMARY (no T-SQL) — read a body with `ib dev schema trigger <name>`.",
        errors: [
          ...devErrors,
          invalidNameErr,
          apiErr(
            404,
            "Table not found",
            "check the name via `ib dev schema tables`. The 404 disambiguates for you: when the name exists as another object CLASS it names the command that reads it (a trigger → `ib dev schema trigger`), and when `<name>Id` is some table's PRIMARY KEY it names that table (`tuote` → `tuotteet`). So a not-found on a name you are sure of means wrong COMMAND or wrong WORD, not a typo."
          ),
        ],
        notes: [
          "ENFORCEMENT, not just existence (fb#425): `disabled` on a foreign key or CHECK means it is NOT checked on write — the constraint is inert and violating rows can land. `notTrusted` means it was re-enabled without a re-check, so existing rows may already violate it. BOTH KEYS ARE OMITTED WHEN FALSE, so their presence is the signal; a healthy table shows neither. Constraint state differs between environments — a dev-vs-prod FK failure is usually this.",
        ],
        examples: ["ib dev schema table keikka", "ib dev schema table keikka,asiakas,tyomaa"],
      },
      {
        command: "ib dev schema views",
        description: "List dbo views with column counts. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: listFlags,
        outputShape:
          "{ items: [{ name, type:'view', columnCount }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: [limitErr("pass a positive integer; max is 1000, and the 200 default returns a PARTIAL catalogue — pass `--limit 1000` whenever you intend to enumerate"), ...devErrors],
        examples: ["ib dev schema views", "ib dev schema views --limit 1000"],
      },
      {
        command: "ib dev schema view",
        description: "Columns and full definition (T-SQL) for one dbo view — or several at once via a comma-separated list. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, columns:[{name,dataType,maxLength,precision,scale,nullable,default,key}], definition:'<T-SQL>' }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false)",
        errors: [...devErrors, invalidNameErr, apiErr(404, "View not found", "check the name via `ib dev schema views` — when the name DOES exist but is another object class, the 404 says so and names the command that reads it (a trigger → `ib dev schema trigger`)")],
        examples: ["ib dev schema view keikkaBetoniView", "ib dev schema view keikkaBetoniView,asiakasView"],
      },
      {
        command: "ib dev schema procs",
        description: "List dbo stored procedures and functions (P/FN/TF/IF). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: listFlags,
        outputShape:
          "{ items: [{ name, type:'P'|'FN'|'TF'|'IF' }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: [limitErr("pass a positive integer; max is 1000, and the 200 default returns a PARTIAL catalogue (dbo holds ~535 procs) — pass `--limit 1000` whenever you intend to enumerate"), ...devErrors],
        examples: ["ib dev schema procs", "ib dev schema procs --search asiakas", "ib dev schema procs --limit 1000"],
      },
      {
        command: "ib dev schema proc",
        description: "Signature (parameters) and full definition (T-SQL) for one dbo proc/function — or several at once via a comma-separated list (read the procs you're about to CREATE OR ALTER in one call). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, type, parameters:[{name,dataType,mode}], definition:'<T-SQL>' }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false)",
        errors: [...devErrors, invalidNameErr, apiErr(404, "Proc/function not found", "check the name via `ib dev schema procs` — when the name DOES exist but is another object class, the 404 says so and names the command that reads it (a trigger → `ib dev schema trigger`)")],
        examples: ["ib dev schema proc asiakas_find", "ib dev schema proc sijainti_save,sijainti_add,asiakas_sijainnit_get"],
      },
      {
        command: "ib dev schema triggers",
        description: "List dbo triggers with their parent table, timing (AFTER / INSTEAD OF), the events that fire them, and whether they are disabled. Narrow to one table with --table. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [
          ...listFlags,
          { name: "table", type: "string", description: "Only triggers whose parent table is this (exact name)" },
        ],
        outputShape:
          "{ items: [{ name, table, timing:'AFTER'|'INSTEAD OF', events:['INSERT'|'UPDATE'|'DELETE'], disabled, type:'trigger' }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: [limitErr("pass a positive integer; max is 1000, and the 200 default returns a PARTIAL catalogue — pass `--limit 1000` whenever you intend to enumerate"), invalidNameErr, ...devErrors],
        notes: [
          "Trigger bodies carry real business logic here (keikka_after_ins_trig creates keikkaBetoni/toimitus/keikkaPerson rows), so a table's writers are not fully described by its procs alone.",
          "`ib dev schema table <name>` already lists that table's triggers in its `triggers` summary — use this command to search across tables or to filter by name.",
        ],
        examples: ["ib dev schema triggers", "ib dev schema triggers --table keikka", "ib dev schema triggers --search updateLastActive"],
      },
      {
        command: "ib dev schema trigger",
        description: "Parent table, timing, events, disabled flag, and full definition (T-SQL) for one dbo trigger — or several at once via a comma-separated list. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, table, timing:'AFTER'|'INSTEAD OF', events:[…], disabled, definition:'<T-SQL>' }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false)",
        errors: [...devErrors, invalidNameErr, apiErr(404, "Trigger not found", "check the name via `ib dev schema triggers` — when the name DOES exist but is another object class, the 404 says so and names the command that reads it")],
        examples: ["ib dev schema trigger keikka_after_ins_trig", "ib dev schema trigger keikka_after_ins_trig,tyomaaPerson_after_ins_trig"],
      },
      {
        command: "ib dev schema rows",
        description: "Sample rows from an allowlisted reference lookup table. Developer-only; table names are validated against a curated allowlist of small, static, tenant-free enum tables: personSettingTypes, asiakasSettingTypes, asiakasPersonSettingTypes, vehicleTypes, keikkaPersonSource, contactPersonTypes, keikkaTila. The keikka trio is what decodes ids the codebase interpolates as bare literals — keikkaPersonSourceId separates a named link from bulk membership fan-out (10/20), contactPersonTypeId 1 is the driver marker, and keikkaTilaId is the status enum behind the 4 / 5,9,12,13,100 magic numbers.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "table", type: "string", description: "Reference table name (e.g. personSettingTypes, keikkaPersonSource, keikkaTila)" }],
        flags: [
          { name: "search", type: "string", description: "Filter rows by substring across the table's string columns (not just a `name` column — most of these tables have none; personSettingTypes carries `description`, asiakasSettingTypes `asiakasSettingType`)" },
          {
            name: "limit",
            type: "number",
            default: "200",
            description: "Max rows to return (max 1000)",
          },
        ],
        outputShape: "{ items: [{ column1, column2, … }], nextCursor: null, count, truncated?, hint? } — row shape depends on the table being queried.",
        errors: [
          apiErr(400, "Table not on allowlist", "use an allowlisted table: personSettingTypes, asiakasSettingTypes, asiakasPersonSettingTypes, vehicleTypes, keikkaPersonSource, contactPersonTypes, keikkaTila"),
          apiErr(404, "Table not found", "verify the table name with `ib dev schema tables`"),
          LIMIT_1000_ERR,
          ...devErrors,
        ],
        notes: [
          "Only a curated set of small, read-only lookup/configuration tables are allowed — no data tables or PII. This is a safe way to understand enum values and type definitions.",
          "Table columns and shapes vary; the rows reflect the actual table schema.",
        ],
        examples: ["ib dev schema rows personSettingTypes", "ib dev schema rows asiakasSettingTypes --search admin", "ib dev schema rows keikkaPersonSource", "ib dev schema rows keikkaTila --search peruttu"],
      },
      {
        command: "ib dev schema dump",
        description: "Whole-schema structural map of the dbo schema (developer-gated, read-only) — all tables with column names and types, FK edges, view names, proc signatures, and trigger summaries. No proc/view/trigger bodies (use `schema proc`/`schema view`/`schema trigger` for those).",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [],
        outputShape: "{ tables:[{name,columns}], foreignKeys:[{table,column,refTable,refColumn,disabled?,notTrusted?}], views:[{name}], procs:[{name,type,parameters}], triggers:[{name,table,timing,events,disabled}] }",
        errors: devErrors,
        notes: [
          "The FK `disabled`/`notTrusted` keys are OMITTED when false, so filtering the dump's foreignKeys for either key answers \"which constraints in the whole schema are not enforced\" in ONE call (fb#425).",
        ],
        examples: ["ib dev schema dump"],
      },
      {
        command: "ib dev schema snapshots",
        description:
          "List migration snapshot tables (the copies migrations take before they delete) with their retention state. Reports only — nothing here drops anything. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "limit", type: "number", default: "200", description: "Max rows (max 1000)" }],
        outputShape:
          "{ items: [{ name, type:'table', rows, createdAt, state:'expired'|'malformed'|'unstamped'|'stamped', dropAfter, origin, reason, daysOverdue }], nextCursor: null, count, truncated?, hint? } — ordered action-first: expired (most overdue) → malformed → unstamped → stamped." + truncNote,
        errors: [LIMIT_1000_ERR, ...devErrors],
        notes: [
          "The retention contract is an `IB_Snapshot` extended property on the table itself, so it travels with the object and dies with it. `origin` names the migration that created the snapshot; `reason` says what it holds.",
          "`unstamped` = the table LOOKS like a snapshot by name but carries no contract — detection deliberately does not rely on the naming convention, since a forgotten stamp is the failure being caught. `malformed` = a stamp with no usable date, which is worse than none: it reads as owned but can never expire.",
          "Expired never means 'drop it automatically'. A monthly `ib task` surfaces these in the morning report and a human decides — dropping a rollback path on a timer is worse than keeping a dead table.",
          "Convention, the 90-day cap and the GDPR position: puminet5api `migrations/README.md` § Snapshot tables.",
        ],
        examples: ["ib dev schema snapshots"],
      },
      {
        command: "ib dev schema query",
        description:
          "Run ONE read-only SELECT (or WITH … SELECT) against the live DB — the ad-hoc path for data-SHAPE questions (COUNT, GROUP BY, histograms, existence probes) that `schema tables/table` cannot answer. Read-over-POST: works under --read-only. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "sql", type: "string", required: true, description: "The SELECT statement (single statement; one trailing ';' tolerated)" }],
        outputShape:
          "{ columns: [name…], rows: [{col: value}…], rowCount, truncated, cap: 1000 }. `truncated: true` = the hard 1000-row cap bit (also warned on stderr) — there is no --limit/--offset; narrow with WHERE or aggregate instead of selecting raw rows.",
        errors: [
          ...devErrors,
          apiErr(
            400,
            "Guard rejection or SQL error",
            "the message IS the answer: guard rejections (not SELECT/WITH first, a non-trailing ';', INTO) mean rephrase to a single read statement — ';'/INTO inside a string LITERAL are documented false positives, rephrase rather than escape; a `SQL error:` prefix means the statement reached the DB and failed there (check names via `ib dev schema table`)"
          ),
          apiErr(503, "Read-only login not provisioned on this backend", "the ib_readonly user is missing — see puminet5api/scripts/database/provision-readonly-sql-user.js; the query NEVER falls back to the read-write pool"),
        ],
        notes: [
          "Runs under the db_datareader-only `ib_readonly` login — writes, EXEC and DDL are denied by PERMISSIONS, not just by the text guard. Query timeout 15s.",
          "dbo scope like the rest of `ib dev schema`. Exists so a data-shape question never again forces a hand-written Node script against the production DB (fb#438).",
        ],
        examples: [
          "ib dev schema query --sql \"SELECT COUNT(*) AS n FROM person\"",
          "ib dev schema query --sql \"SELECT personContactTypeId, COUNT(*) AS n FROM personContact GROUP BY personContactTypeId\"",
        ],
      },
      {
        command: "ib dev schema indexes",
        description:
          "Per-index USAGE statistics for dbo tables — seeks/scans/lookups/updates and last-touch timestamps from sys.dm_db_index_usage_stats. The live answer to \"which indexes are dead weight\" and \"does anything actually read this table\", previously only available from the monthly-generated indexes-performance.md. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [
          { name: "table", type: "string", description: "Only indexes on this table (exact name)" },
          { name: "search", type: "string", description: "Filter by index OR table name substring" },
          {
            name: "limit",
            type: "number",
            default: "200",
            description:
              "Max rows (max 1000). dbo holds several hundred indexes, so a default whole-DB read is a PARTIAL list; pass --limit 1000 whenever you intend to enumerate.",
          },
          {
            name: "unused",
            type: "boolean",
            description:
              "Only indexes with ZERO reads since statsSince (filtered server-side, so the row limit is spent on the interesting rows)",
          },
        ],
        outputShape:
          "{ statsSince, items: [{ table, index, columns, type:'CLUSTERED'|'NONCLUSTERED'|…, unique, primaryKey?, filter?, seeks, scans, lookups, updates, lastRead, lastWrite, unused? }], nextCursor: null, count, truncated?, hint? }. `primaryKey`/`filter`/`unused` are OMITTED when false — presence is the signal." +
          truncNote,
        prettyColumns: ["table", "index", "seeks", "scans", "lookups", "updates", "lastRead", "lastWrite"],
        errors: [
          LIMIT_1000_ERR,
          invalidNameErr,
          ...devErrors,
          {
            http: 503,
            exit: 6,
            match: "dmv_permission",
            meaning:
              "The backend's SQL principal cannot read sys.dm_db_index_usage_stats. In PRODUCTION that is the normal state, not an outage: puminet_app is a contained database user on the Standard S1 tier, where the usage DMVs need ##MS_ServerStateReader## server-role membership that only a server-level login can hold — no GRANT fixes it (fb#923)",
            remedy:
              "read production usage stats from the monthly docs generator (docs/tech/database indexes-performance.md), or run this against a LOCAL backend whose SQL login is server-level (--endpoint http://127.0.0.1:<port>)",
          },
        ],
        notes: [
          "Counters RESET on every SQL Server restart/failover — `statsSince` is when the current window began. Zero reads two days after a failover proves nothing; check statsSince before calling an index dead, and prefer a window covering month-end/seasonal workloads.",
          "An `unused` index with high `updates` is pure write cost — the strongest drop candidate. `lastRead`/`lastWrite` are the most recent seek/scan/lookup and update timestamps within the window.",
        ],
        examples: [
          "ib dev schema indexes --table keikka",
          "ib dev schema indexes --unused --limit 1000",
          "ib dev schema indexes --search sijainti",
        ],
      },
    ];
  })(),
];
