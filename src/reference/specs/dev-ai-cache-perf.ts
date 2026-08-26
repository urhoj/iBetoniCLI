// dev-ai-cache-perf specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandError, CommandSpec } from "../../output/help.js";
import { apiErr, COMMON_AUTH_ERRORS } from "./shared.js";

export const DEV_AI_CACHE_PERF_SPECS: CommandSpec[] = [
  // ─── ai (2) — read AI assistant conversations ────────────────────────────
  {
    command: "ib dev ai conversations",
    description:
      "List recent /ai assistant conversations CROSS-TENANT for audit/browse (compact rows, newest-first, no message bodies). Developer/sysadmin tooling — the way to discover conversationIds to audit without an `ib feedback` row pointing at one. Drill into a transcript with `ib dev ai conversation <id>`.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "limit", type: "number", default: "20", description: "Max rows to return (1-100)" },
      { name: "person", type: "number", description: "Filter to one person's conversations (personId)" },
    ],
    outputShape:
      "ListEnvelope<{ conversationId, personId, ownerAsiakasId, entryTime, messageCount }> (truncated:true when the page hit --limit)",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--limit must be 1-100; --person must be a positive integer" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Cross-tenant by design: rows from EVERY tenant are returned and the active --company does NOT narrow them (each row carries its own ownerAsiakasId). Transcripts may contain PII — hence the developer gate.",
      "Excludes archived conversations (gptConversations.isArchived=1) and conversations with zero messages, so an id taken from a feedback row can legitimately be absent here while `ib dev ai conversation <id>` still returns it.",
      "No cursor: nextCursor is always null. truncated:true means the page filled --limit — raise --limit (max 100) rather than trying to page.",
    ],
    seeAlso: ["ib dev ai conversation", "ib dev feedback list"],
    examples: [
      "ib dev ai conversations",
      "ib dev ai conversations --limit 50",
      "ib dev ai conversations --person 6233",
    ],
  },
  {
    command: "ib dev ai conversation",
    description:
      "Fetch the full transcript of an /ai assistant conversation by id (gptConversations/gptMessages). Developer/sysadmin tooling. Get an id by browsing with `ib dev ai conversations`, or from an `ib feedback` row's context.conversationId — stamped automatically when the AI files feedback from the /ai page.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "conversationId", type: "number", description: "gptConversations id (from `ib dev ai conversations` or a feedback row's context.conversationId)" }],
    flags: [],
    outputShape:
      "{ conversationId, personId, ownerAsiakasId, messageCount, messages: [{ gptMessageId, keikkaId, role?, content?, raw?, ... }] }",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "conversationId must be a positive integer" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(404, "Not found", "no conversation with that id"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Cross-tenant by design: the transcript is readable whatever the caller's active company, because the AI fixer triages `ib feedback` rows from any tenant. Transcripts may contain PII — hence the developer gate.",
      "Each message is { gptMessageId, keikkaId, ...JSON.parse(gptMessages.message) } — normally role/content, but a row whose stored message is NOT valid JSON falls back to { gptMessageId, keikkaId, raw }. Handle `raw` as well as `content`.",
    ],
    seeAlso: ["ib dev ai conversations", "ib dev feedback get", "ib dev feedback list"],
    examples: ["ib dev ai conversation 4321"],
  },
  // ─── cache (6) — Redis inspection and invalidation ───────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["isSystemAdmin or isDeveloper"];
    const ADMIN_PERMS = ["admin role (SystemAdmin, AsiakasAdmin, or LaskuAdmin) or developer"];
    const devErrors: CommandError[] = [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a developer", "requires isSystemAdmin or isDeveloper"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ];
    const refusedRemote: CommandError = {
      origin: "client",
      exit: 3,
      match: "shared-cache",
      meaning: "Refused: deployed endpoint without --force-prod",
      remedy: "prod and staging share Redis DB 3; add --force-prod or use a local endpoint",
    };
    const readOnlyErr: CommandError = {
      origin: "client",
      exit: 3,
      match: "read-only mode is active",
      meaning: "Blocked by read-only mode",
      remedy: "executing a cache write needs --confirm and a session without --read-only/IB_READ_ONLY (previews still work)",
    };
    const writeFlags = [
      { name: "confirm", type: "boolean", description: "Execute the operation (default is dry-run preview)" },
      { name: "dry-run", type: "boolean", description: "Preview without deleting — the DEFAULT here, so this flag is an explicit no-op. Accepted because it is the CLI-wide preview spelling; this group inverts the usual idiom and previews unless --confirm. Passing it WITH --confirm exits 4 rather than picking a winner." },
      { name: "force-prod", type: "boolean", description: "Execute against a deployed (shared-cache) backend. Sent as X-Force-Prod: 1; a deployed backend refuses destructive cache ops without it (403) — including calls routed via /api/cli/exec and MCP ib_exec." },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason)" },
    ];
    const contradictoryWriteFlags: CommandError = {
      origin: "client",
      exit: 4,
      match: "mutually exclusive",
      meaning: "--dry-run and --confirm passed together",
      remedy: "drop --dry-run to execute, or drop --confirm to preview (preview is the default)",
    };
    return [
      {
        command: "ib dev cache stats",
        description: "Redis connection status, total key count, and hit rate. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [],
        outputShape: "{ connected, totalKeys, hitRate?, usedMemory? }",
        errors: devErrors,
        examples: ["ib dev cache stats"],
      },
      {
        command: "ib dev cache keys",
        description: "Key counts grouped by prefix pattern (SCAN). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "pattern", type: "string", default: "*", description: "SCAN match glob (default: *)" }],
        outputShape: "{ totalKeys, groups: [{ prefix, count }] }",
        errors: devErrors,
        examples: ["ib dev cache keys", "ib dev cache keys --pattern 'keikka:*'"],
      },
      {
        command: "ib dev cache invalidate",
        description: "Invalidate cache for one entity family by domain identifier (no Redis key knowledge needed). Previews (X-Dry-Run) unless --confirm. --cascade fans out to related families (keikka only). Any admin; non-developers are scoped to their own company. Guard: refuses deployed endpoints unless --force-prod (all slots share Redis DB 3).",
        permissions: ADMIN_PERMS,
        mutates: true,
        args: [{ name: "entityType", type: "string", description: "Entity family, e.g. keikka/asiakas/vehicle (see `ib dev cache entities`)" }],
        flags: [
          { name: "id", type: "number", description: "Entity id (e.g. keikkaId)" },
          { name: "asiakas", type: "number", description: "Tenant scope (developers may target others; non-devs use their own)" },
          { name: "cascade", type: "boolean", description: "Also invalidate related families (keikka only)" },
          ...writeFlags,
        ],
        outputShape: "preview: { dryRun:true, wouldDelete, patterns[] } | execute: { dryRun:false, deleted }",
        errors: [
          apiErr(400, "Unknown entityType or cascade unsupported", "run `ib dev cache entities` to list valid types"),
          apiErr(403, "Not an admin, or cross-tenant entity needs developer", "cross-tenant entities (keikka, grid, stat, attachment) require isSystemAdmin/isDeveloper; others need an admin role"),
          refusedRemote,
          readOnlyErr,
          contradictoryWriteFlags,
          ...COMMON_AUTH_ERRORS,
        ],
        notes: [
          "Without --confirm the command only PREVIEWS (counts keys) and never deletes.",
          "This group INVERTS the CLI-wide write-safety idiom: elsewhere a write performs by default and --dry-run previews; here it previews by default and --confirm performs. --dry-run is accepted as an explicit spelling of that default so the two idioms compose.",
          "Single-entity invalidate may leave related caches (grid/stepLog/attachments) stale — use --cascade (keikka) or invalidate each family.",
        ],
        seeAlso: ["ib dev cache entities", "ib dev cache keys"],
        examples: [
          "ib dev cache invalidate keikka --id 123",
          "ib dev cache invalidate keikka --id 123 --cascade --confirm",
          "ib dev cache invalidate asiakas --asiakas 8 --confirm",
        ],
      },
      {
        command: "ib dev cache clear",
        description: "Flush the entire Redis cache (curated sweep; preserves sessions/locks/metrics). Previews (X-Dry-Run) unless --confirm. Cross-tenant: clears every company's cached data. Guard: refuses deployed endpoints unless --force-prod. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        mutates: true,
        flags: writeFlags,
        outputShape: "preview: { dryRun:true, wouldDelete } | execute: { deleted }",
        errors: [...devErrors, refusedRemote, readOnlyErr, contradictoryWriteFlags],
        examples: ["ib dev cache clear", "ib dev cache clear --confirm --force-prod"],
      },
      {
        command: "ib dev cache pattern",
        description: "Invalidate keys matching a raw Redis glob. Previews unless --confirm. Guard: refuses deployed endpoints unless --force-prod. Developer-only. Prefer `ib dev cache invalidate` (domain entity); use `ib dev cache keys` to find the right glob.",
        permissions: DEV_PERMS,
        tier: "developer",
        mutates: true,
        args: [{ name: "glob", type: "string", required: false, description: "Raw Redis key glob (e.g. 'keikka:*'). Alias: --pattern <glob>, matching the spelling the sibling `ib dev cache keys` uses for the same concept — exactly one is required, both only if they agree." }],
        flags: [
          { name: "pattern", type: "string", description: "Raw Redis key glob (alias for the positional)" },
          ...writeFlags,
        ],
        outputShape:
          "preview: { dryRun:true, wouldDelete, pattern, sampleKeys } | execute: { deleted, pattern }. When wouldDelete is 0 the preview ALSO carries { totalKeys, existingPrefixes[], hint } — a zero alone cannot tell 'cache is clean' from 'your glob is wrong', so those fields settle it without a second command (feedback #431).",
        errors: [
          ...devErrors,
          refusedRemote,
          readOnlyErr,
          contradictoryWriteFlags,
          {
            origin: "client",
            exit: 4,
            // Matches the shared resolveDualString message ("missing glob: …").
            // matchClientRow keys on the message TEXT, and this command now has
            // two client rows at exit 4, so the single-row fallback cannot
            // rescue a stale string — it would silently serve no remedy at all
            // (the dead-row class of feedback #280/#289).
            match: "missing glob",
            meaning: "No glob given, positionally or via --pattern",
            remedy: "pass the glob positionally (`ib dev cache pattern 'keikka:*'`) or as --pattern 'keikka:*'",
          },
          {
            origin: "client",
            exit: 4,
            match: "differ",
            meaning: "The positional glob and --pattern were both given and disagree",
            remedy: "pass the glob ONCE — only one of the two could be honoured, so the CLI refuses rather than silently picking",
          },
        ],
        examples: [
          "ib dev cache pattern 'keikka:*'",
          "ib dev cache pattern --pattern 'keikka:*'",
          "ib dev cache pattern 'person:*' --confirm --force-prod",
        ],
      },
      {
        command: "ib dev cache entities",
        description: "List the valid cache entity types, their scope params (id/asiakasId), cascade support, and example invalidation commands. Offline — no auth required.",
        auth: "none",
        flags: [],
        outputShape: "{ items: [{ entityType, params[], cascade?, developerOnly?, example }], count }",
        errors: [{ origin: "client", exit: 0, meaning: "Always succeeds (offline static list)", remedy: "n/a" }],
        examples: ["ib dev cache entities"],
      },
    ];
  })(),

  // ─── perf (4) — SQL slow-query monitoring ────────────────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["isSystemAdmin or isDeveloper"];
    const devErrors: CommandError[] = [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a developer", "requires isSystemAdmin or isDeveloper"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ];
    const COVERAGE_NOTE =
      "SQL durations cover the executeQuery (cache-runner) path only — raw getConnection() queries are not timed.";
    return [
      {
        command: "ib dev perf slow",
        description: "Recent slow queries from the collector's Redis ring buffer (procedure, durationMs, entity, params, timestamp). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [
          { name: "limit", type: "number", default: "50", description: "Max rows" },
          { name: "env", type: "string", description: "Environment buffer to read (default: backend's current env; discover via `ib dev perf config`)" },
        ],
        outputShape: "ListEnvelope<{ procedure, durationMs, entity, params, timestamp }> & { totalCount?, environment? } (+truncated:true when the page filled the limit)",
        errors: devErrors,
        notes: [COVERAGE_NOTE, "Threshold to be 'slow' is the collector's SLOW_QUERY_THRESHOLD_MS (default 1000ms) — see `ib dev perf config`."],
        seeAlso: ["ib dev perf stats", "ib dev perf config"],
        examples: ["ib dev perf slow", "ib dev perf slow --limit 20 --env production"],
      },
      {
        command: "ib dev perf stats",
        description: "Aggregate slow-query stats: top procedures (count/avgMs), avg/max/min duration, by-entity breakdown, lifetime totalCount. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "env", type: "string", description: "Environment buffer to read (default: backend's current env)" }],
        outputShape: "{ totalSlowQueries, bufferedQueries, avgDuration, maxDuration, minDuration, topProcedures:[{ name, count, avgMs }], byEntity, since, threshold, sentryThreshold, environment }",
        errors: devErrors,
        notes: [COVERAGE_NOTE],
        seeAlso: ["ib dev perf slow", "ib dev perf config"],
        examples: ["ib dev perf stats", "ib dev perf stats --env staging"],
      },
      {
        command: "ib dev perf config",
        description: "Slow-query collector configuration (enabled, threshold, sentryThreshold, maxEntries, current environment) plus availableEnvironments that have data. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [],
        outputShape: "{ enabled, threshold, sentryThreshold, maxEntries, environment, availableEnvironments:[string] }",
        errors: devErrors,
        seeAlso: ["ib dev perf slow", "ib dev perf stats"],
        examples: ["ib dev perf config"],
      },
      {
        command: "ib dev perf clear",
        description: "Clear the slow-query buffer for one environment. Previews with --dry-run (client-side); --reason recommended for the audit log. Developer-only; refused under --read-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        writeFlags: true,
        dryRunKind: "client",
        flags: [{ name: "env", type: "string", description: "Environment buffer to clear (default: backend's current env)" }],
        outputShape: "execute: { cleared:true, environment, message } | --dry-run: { dryRun:true, wouldClear:{ method, path } }",
        errors: [
          ...devErrors,
          { origin: "client", exit: 3, meaning: "Blocked by read-only mode", remedy: "clearing needs a session without --read-only/IB_READ_ONLY" },
        ],
        seeAlso: ["ib dev perf stats"],
        examples: ['ib dev perf clear --env staging --reason "reset after load test"', "ib dev perf clear --dry-run"],
      },
    ];
  })(),
];
