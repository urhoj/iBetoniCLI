// message specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec, CommandFlag } from "../../output/help.js";
import { COMMON_AUTH_ERRORS, FROM_JSON_FLAGS_FLAG, PERSON_PARSE_ERR, SEARCH_ALIAS_FLAG, apiErr, clearNote, intParseErr, limitErr } from "./shared.js";

/** The `--tarjous` thread-target alias every thread-addressed leaf repeats. */
const TARJOUS_THREAD_FLAG: CommandFlag = {
  name: "tarjous",
  type: "number",
  description: "Resolve the thread from this pumppuRequestId",
};

/** The authorization note every `message thread` lifecycle leaf states. */
const MANAGER_GATED_NOTE =
  "Manager-gated (canManageThread): owning-company admin/owner, or isSystemAdmin/isDeveloper.";

/** The `--tarjous` parse-guard row every thread-targeting leaf shares (addThreadTargetOption). */
const TARJOUS_PARSE_ERR = intParseErr("--tarjous", "pass a positive pumppuRequestId");
/** The `--thread` parse-guard row for the leaves that register it directly (chat delete/edit/restore). */
const THREAD_PARSE_ERR = intParseErr("--thread", "pass a positive threadId");

export const MESSAGE_SPECS: CommandSpec[] = [
  // ─── message chat (9) ────────────────────────────────────────────────────
  {
    command: "ib message chat threads",
    description:
      "List your conversational message threads (inbox), newest first, with unread counts and a last-message preview. Projects GET /api/messages/threads/mine into the list envelope; --unread / --tarjous filter client-side.",
    auth: "any",
    flags: [
      { name: "unread", type: "boolean", description: "Only threads with unreadCount > 0" },
      { name: "tarjous", type: "number", description: "Only threads for this pumppuRequestId" },
    ],
    outputShape:
      "ListEnvelope<{ threadId, contextType, contextId, ownerAsiakasId, createdAt, lastMessageAt, lastReadAt, unreadCount, lastMessageBody }>",
    errors: [TARJOUS_PARSE_ERR, ...COMMON_AUTH_ERRORS],
    notes: [
      "Only threads you participate in are returned (server-scoped by your personId).",
      "A keikka thread (contextType 'keikka') appears here automatically once keikka messaging ships — no CLI change needed.",
    ],
    seeAlso: ["ib message chat list", "ib message chat thread"],
    examples: [
      "ib message chat threads",
      "ib message chat threads --unread",
      "ib message chat threads --tarjous 23",
    ],
  },
  {
    command: "ib message chat thread",
    description:
      "Get one thread's metadata + participants (display names, roles, asiakas). Target by threadId positional or resolve from --tarjous.",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      TARJOUS_THREAD_FLAG,
    ],
    outputShape:
      "{ thread: { threadId, contextType, contextId, ownerAsiakasId, createdAt, lastMessageAt, archivedAt }, participants: [{ participantId, personId, asiakasId, role, joinedAt, lastReadAt, leftAt, personFirstName, personLastName, asiakasNimi }] }",
    errors: [
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not a participant of this thread", "you can only read threads you are part of"),
      apiErr(404, "Thread not found", "verify the threadId / --tarjous"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--tarjous resolves client-side over /threads/mine; if it matches multiple threads (one per competing provider) you get exit 4 listing the threadIds — pass one explicitly.",
    ],
    seeAlso: ["ib message chat threads", "ib message chat list"],
    examples: ["ib message chat thread 42", "ib message chat thread --tarjous 23"],
  },
  {
    command: "ib message chat list",
    description:
      "List messages in a thread, oldest first. Does NOT mark the thread read (use `ib message chat mark-read`). Target by threadId or --tarjous; --since backfills, --limit caps.",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      TARJOUS_THREAD_FLAG,
      { name: "since", type: "string", description: "Only messages created after this ISO timestamp" },
      { name: "limit", type: "number", default: "100", description: "Max messages (server max 500)" },
      { name: "deleted", type: "boolean", description: "Include soft-deleted messages (your own; all for developers)" },
    ],
    outputShape:
      "ListEnvelope<{ messageId, threadId, senderPersonId, senderAsiakasId, kind, body, source, sourceNote, createdAt, editedAt, isDeleted, personFirstName, personLastName, senderAsiakasNimi }>",
    errors: [
      TARJOUS_PARSE_ERR,
      limitErr("pass a positive integer; this command caps at 500"),
      apiErr(403, "Not a participant of this thread", "you can only read threads you are part of"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Reading does NOT stamp lastReadAt — safe for an AI to browse without clearing your unread badge.",
      "source/sourceNote are null until the provenance backend change is deployed.",
      "--deleted sets ?includeDeleted=1: you see your own deleted rows, developers see all; rows carry isDeleted.",
    ],
    seeAlso: ["ib message chat send", "ib message chat mark-read"],
    examples: [
      "ib message chat list 42",
      "ib message chat list --tarjous 23 --limit 20",
      "ib message chat list 42 --since 2026-06-14T10:00:00Z",
    ],
  },
  {
    command: "ib message chat send",
    description:
      "Send a message to a thread (POST /api/messages/threads/:id/messages). Outward-facing: the recipient sees it and gets a push. --dry-run previews the body + recipients CLIENT-SIDE without sending. --reason is stored as the message's sourceNote (optional).",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      TARJOUS_THREAD_FLAG,
      { name: "body", type: "string", required: true, description: "Message text (max 4000 chars)" },
      { name: "source", type: "string", description: "Provenance: web|cli|ai (default: IB_SOURCE env or cli)" },
      FROM_JSON_FLAGS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, senderPersonId, senderAsiakasId, kind, body, source, sourceNote, createdAt } · { dryRun:true, threadId, wouldSend:{ body, source, sourceNote, recipients:[{ personId, name, role }] } } on --dry-run",
    errors: [
      // CLIENT-side, not a backend 400 (fb#668 class): both length guards are
      // `failWith(..., 4)` in the action, so the request is never sent and no
      // 400 can arrive — dead by the fb#280 rule, leaving the caller no hint.
      { origin: "client", exit: 4, match: ["message body cannot be empty", "message body too long"], meaning: "Empty or over-length --body", remedy: "body is required, max 4000 chars" },
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not a participant of this thread", "you can only post to threads you are part of"),
      apiErr(409, "Thread archived", "archived threads are read-only"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--dry-run only issues a GET (thread participants) — it works under --read-only and never persists.",
      "--reason → sourceNote (optional; chat is conversational). source/sourceNote are persisted only after the provenance backend change deploys; until then the API silently ignores them.",
      "An AI-driven send sets source=ai automatically via the IB_SOURCE env var.",
    ],
    seeAlso: ["ib message chat list", "ib message chat thread"],
    examples: [
      'ib message chat send 42 --body "Onko tyomaalle ajoyhteys raskaalle kalustolle?"',
      'ib message chat send --tarjous 23 --body "Kiitos tarjouksesta" --dry-run',
      'ib message chat send 42 --body "Vahvistettu" --reason "confirmed by phone"',
    ],
  },
  {
    command: "ib message chat mark-read",
    description:
      "Mark a thread read — stamp your lastReadAt to now (POST /api/messages/threads/:id/read), clearing the unread badge. A write, so blocked under --read-only.",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      TARJOUS_THREAD_FLAG,
    ],
    mutates: true,
    outputShape: "{ lastReadAt }",
    errors: [
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not a participant of this thread", "you can only mark threads you are part of"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Deliberately separate from `list` so reading never auto-marks (an AI can browse without clearing your unread state).",
    ],
    seeAlso: ["ib message chat list", "ib message chat threads"],
    examples: ["ib message chat mark-read 42", "ib message chat mark-read --tarjous 23"],
  },
  {
    command: "ib message chat delete",
    description:
      "Soft-delete a chat message (DELETE /api/messages/threads/:id/messages/:messageId; sets isDeleted=1, so it vanishes from every read). The author may delete their OWN message only while it is unanswered (no later reply from another participant); a sysadmin/developer may moderate any message in a thread they can access.",
    auth: "any",
    args: [
      { name: "messageId", type: "number", required: true, description: "Message id to delete (the message PK)" },
    ],
    flags: [
      { name: "thread", type: "number", description: "Thread id the message belongs to" },
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId (one match required)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, deleted:true } (+ alreadyDeleted:true if already gone) · { dryRun:true, threadId, wouldDelete:{ messageId, body, senderPersonId } } on --dry-run",
    errors: [
      THREAD_PARSE_ERR,
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not the author (and not a developer)", "you can only delete your own messages"),
      apiErr(409, "Already answered", "a message someone replied to after cannot be retracted — delete the newest first"),
      apiErr(404, "Thread or message not found", "check the threadId/messageId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Soft-delete: the row is kept for audit but is filtered from list/threads/unread (all carry isDeleted=0). There is no hard delete.",
      "--dry-run only issues a GET (thread messages) to echo the target — it works under --read-only and never deletes (the route has no X-Dry-Run guard).",
      "Locate the thread with --thread <id> or --tarjous <id>; a tarjous with multiple threads requires --thread.",
      "Deploy-gated: the DELETE route must be deployed to the target backend before this works.",
    ],
    seeAlso: ["ib message chat send", "ib message chat list"],
    examples: [
      'ib message chat delete 5 --thread 3 --reason "test cleanup"',
      "ib message chat delete 5 --tarjous 23 --dry-run",
    ],
  },
  {
    command: "ib message chat edit",
    description:
      "Edit a chat message's body (PATCH /api/messages/threads/:id/messages/:messageId). Author-only and only while unanswered (no later reply from a different participant). Moderators cannot edit. Sets editedAt, emits message:edited, no-ops if the body is unchanged. --dry-run previews the from→to diff CLIENT-SIDE.",
    auth: "any",
    args: [{ name: "messageId", type: "number", required: true, description: "Message id to edit (the message PK)" }],
    flags: [
      { name: "thread", type: "number", description: "Thread id the message belongs to" },
      TARJOUS_THREAD_FLAG,
      { name: "body", type: "string", required: true, description: "New message text (max 4000 chars)" },
      FROM_JSON_FLAGS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, senderPersonId, body, editedAt, ... } (enriched row) · { messageId, threadId, unchanged:true } on no-op · { dryRun:true, threadId, wouldEdit:{ messageId, from, to } } on --dry-run",
    errors: [
      // CLIENT-side, not a backend 400 (fb#668 class): both length guards are
      // `failWith(..., 4)` in the action, so the request is never sent and no
      // 400 can arrive — dead by the fb#280 rule, leaving the caller no hint.
      { origin: "client", exit: 4, match: ["message body cannot be empty", "message body too long"], meaning: "Empty or over-length --body", remedy: "body is required, max 4000 chars" },
      THREAD_PARSE_ERR,
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not the author", "you can only edit your own messages"),
      apiErr(404, "Thread or message not found", "check the threadId/messageId"),
      apiErr(409, "Answered or deleted", "you cannot edit a message that was replied to, or a deleted one"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Author-only — no moderator override (rewriting another person's words is worse than deleting).",
      "--dry-run lists the thread to show the diff; it never PATCHes (works under --read-only).",
      "Deploy-gated: the PATCH route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message chat send", "ib message chat delete"],
    examples: [
      'ib message chat edit 7 --thread 3 --body "korjattu teksti" --reason typo',
      'ib message chat edit 7 --tarjous 23 --body "korjattu" --dry-run',
    ],
  },
  {
    command: "ib message chat restore",
    description:
      "Restore a soft-deleted chat message (POST /api/messages/threads/:id/messages/:messageId/restore; isDeleted=0). The author OR a sysadmin/developer may restore. Idempotent (already-active → alreadyActive:true). Emits message:restored. Find deleted ids with `ib message chat list --deleted`. --dry-run previews CLIENT-SIDE via the deleted list.",
    auth: "any",
    args: [{ name: "messageId", type: "number", required: true, description: "Message id to restore (the message PK)" }],
    flags: [
      { name: "thread", type: "number", description: "Thread id the message belongs to" },
      TARJOUS_THREAD_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, restored:true } (+ alreadyActive:true if not deleted) · { dryRun:true, threadId, wouldRestore:{ messageId } } on --dry-run",
    errors: [
      THREAD_PARSE_ERR,
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not the author (and not a developer)", "you can only restore your own messages"),
      apiErr(404, "Thread or message not found", "check the threadId/messageId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Deleted messages are hidden from the normal list — use `ib message chat list --deleted` to find ids.",
      "--dry-run lists deleted messages to confirm the target; it never restores (works under --read-only).",
      "Deploy-gated: the restore route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message chat delete", "ib message chat list"],
    examples: [
      "ib message chat restore 7 --thread 3 --reason \"deleted by mistake\"",
      "ib message chat restore 7 --tarjous 23 --dry-run",
    ],
  },
  {
    command: "ib message chat search",
    description:
      "Search your own chat messages by body text (GET /api/messages/search). Scoped to threads you participate in (the participant JOIN is the tenant boundary); non-deleted only; newest first. q min 2 chars; --limit default 50, max 200.",
    auth: "any",
    args: [{ name: "query", type: "string", required: false, description: "Body substring to search for (min 2 chars) — or pass --search" }],
    flags: [
      SEARCH_ALIAS_FLAG,
      { name: "limit", type: "number", default: "50", description: "Max results (server max 200)" },
    ],
    outputShape:
      "ListEnvelope<{ messageId, threadId, contextType, contextId, senderPersonId, body, createdAt, personFirstName, personLastName }>",
    errors: [
      limitErr("pass a positive integer; this command caps at 200"),
      apiErr(400, "Query too short", "q must be at least 2 characters"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Only your own threads are searched — the participant JOIN is the tenant boundary.",
      "Substring (LIKE) match; literal % / _ in the query are matched literally.",
      "Deploy-gated: the /search route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message chat list", "ib message chat threads"],
    examples: [
      'ib message chat search "betoni"',
      'ib message chat search "ajoyhteys" --limit 20',
    ],
  },
  // ─── message support (4) ──────────────────────────────────────────────────
  {
    command: "ib message support inbox",
    description:
      "Support triage queue: support threads escalated by operators, newest first. Developer-only (isSystemAdmin / isDeveloper). Filter by lifecycle status. Projects GET /api/messages/support/inbox into the list envelope.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", default: "open", description: "open | resolved | all", allowed: ["open", "resolved", "all"] },
      { name: "limit", type: "number", description: "Max rows" },
    ],
    outputShape: "{ items: SupportThreadRow[], nextCursor: null, count, truncated }",
    errors: [
      { origin: "client", exit: 4, match: "must be one of", meaning: "Validation", remedy: "--status must be open|resolved|all" },
      intParseErr("--limit", "pass a positive integer"),
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Read a thread's messages with `ib message chat list <threadId>` and reply with `ib message chat send <threadId> --body ...` (a support thread is a normal messageThread admins can read).",
    ],
    seeAlso: ["ib message chat list", "ib message support resolve"],
    examples: [
      "ib message support inbox",
      "ib message support inbox --status all --limit 50",
    ],
  },
  {
    command: "ib message support mine",
    description:
      "Your own company's support threads (audience='support', owned by your active company), newest first. The operator-facing companion to the developer-only inbox — any member of the owning company may list them. Filter by lifecycle status. Projects GET /api/messages/support/mine into the list envelope; each row carries a caller-scoped unreadCount.",
    flags: [
      { name: "status", type: "string", default: "open", description: "open | resolved | all", allowed: ["open", "resolved", "all"] },
      { name: "limit", type: "number", description: "Max rows" },
    ],
    outputShape: "{ items: SupportThreadRow[], nextCursor: null, count, truncated }",
    errors: [
      { origin: "client", exit: 4, match: "must be one of", meaning: "Validation", remedy: "--status must be open|resolved|all" },
      intParseErr("--limit", "pass a positive integer"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(404, "Route not deployed", "the /support/mine backend may not be deployed yet"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Read a thread's messages with `ib message chat list <threadId>` and reply with `ib message chat send <threadId> --body ...`. Open (or append to) a new escalation with `ib message support contact`.",
    ],
    seeAlso: ["ib message support contact", "ib message chat list"],
    examples: [
      "ib message support mine",
      "ib message support mine --status all --limit 50",
    ],
  },
  {
    command: "ib message support contact",
    description:
      "Open (or append to) a support thread escalating a tarjous (pumppuRequest) or keikka to the platform. Any authenticated user. A REAL write — honours the read-only write-lock. --dry-run resolves CLIENT-SIDE (prints the payload, never POSTs). Reply later with `ib message chat send <threadId> --body ...`.",
    auth: "any",
    mutates: true,
    dryRunKind: "client",
    flags: [
      { name: "tarjous", type: "number", description: "pumppuRequestId this escalation is about" },
      { name: "keikka", type: "number", description: "keikkaId this escalation is about" },
      { name: "body", type: "string", required: true, description: "The message to support" },
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
      FROM_JSON_FLAGS_FLAG,
    ],
    outputShape:
      "{ threadId, message } on success. With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "Provide exactly one of --keikka / --tarjous (positive integer) and a non-empty --body" },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Exactly one of --keikka / --tarjous selects the context; --keikka wins if both are passed.",
      "reply with: ib message chat send <threadId> --body ...",
    ],
    seeAlso: ["ib message chat send", "ib message support inbox"],
    examples: [
      'ib message support contact --tarjous 23 --body "Provider not responding — please intervene"',
      'ib message support contact --keikka 5012 --body "Wrong worksite assigned" --dry-run',
    ],
  },
  {
    command: "ib message support resolve",
    description:
      "Mark a support thread resolved, or --reopen it back to open. Developer-only (isSystemAdmin / isDeveloper). A REAL write (PATCH) — blocked under --read-only (exit 3). --dry-run previews the body client-side without sending.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "threadId", type: "number", description: "support messageThread id" }],
    flags: [
      { name: "reopen", type: "boolean", description: "Set status back to open instead of resolved" },
      { name: "dry-run", type: "boolean", description: "Print the update body without sending (client-side)" },
    ],
    outputShape:
      "{ threadId, status } on success. With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "threadId must be a positive number" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the threadId via `ib message support inbox`"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib message support inbox", "ib message chat list"],
    examples: [
      "ib message support resolve 42",
      "ib message support resolve 42 --reopen",
    ],
  },
  // ─── message thread (5) ──────────────────────────────────────────────────────
  {
    command: "ib message thread archive",
    description:
      "Archive a thread (POST /api/messages/threads/:id/archive). Sets archivedAt — the thread becomes read-only; send/edit/restore then 409. Idempotent (already archived → alreadyArchived:true). Manager-gated: owning-company admin or sysadmin/developer.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      TARJOUS_THREAD_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, archived:true } (+ alreadyArchived:true if already archived)",
    errors: [
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MANAGER_GATED_NOTE,
      "Archived thread is read-only — send/edit/restore return 409 until reopened.",
      "Idempotent: archiving an already-archived thread returns alreadyArchived:true (no error).",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldArchive:{...} } and never POSTs — works under --read-only.",
      "Deploy-gated: the archive route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread reopen", "ib message chat send"],
    examples: [
      "ib message thread archive 3 --reason \"case closed\"",
      "ib message thread archive --tarjous 23",
    ],
  },
  {
    command: "ib message thread reopen",
    description:
      "Reopen an archived thread (POST /api/messages/threads/:id/reopen). Clears archivedAt so messages can be sent again. Idempotent (already open → alreadyOpen:true). Manager-gated: owning-company admin or sysadmin/developer.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      TARJOUS_THREAD_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, archived:false } (+ alreadyOpen:true if already open)",
    errors: [
      TARJOUS_PARSE_ERR,
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MANAGER_GATED_NOTE,
      "Idempotent: reopening an already-open thread returns alreadyOpen:true (no error).",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldReopen:{...} } and never POSTs — works under --read-only.",
      "Deploy-gated: the reopen route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread archive", "ib message chat send"],
    examples: [
      "ib message thread reopen 3 --reason \"new information\"",
      "ib message thread reopen --tarjous 23",
    ],
  },
  {
    command: "ib message thread rename",
    description:
      'Set or clear the thread title (PATCH /api/messages/threads/:id; body { title }). Title max 200 chars; empty string clears it (sets to NULL). Manager-gated: owning-company admin or sysadmin/developer. Requires the messageThread.title migration to have run on the DB before the rename route is deployed.',
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      TARJOUS_THREAD_FLAG,
      { name: "title", type: "string", required: true, description: 'New thread title (max 200 chars; "" clears)' },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, title } (title is null when cleared)",
    errors: [
      TARJOUS_PARSE_ERR,
      apiErr(400, "Title too long", "max 200 characters"),
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MANAGER_GATED_NOTE,
      'Pass --title "" to clear the title (sets messageThread.title = NULL). ' + clearNote("--title"),
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldRename:{...} } and never PATCHes — works under --read-only.",
      "Deploy-gated: requires the messageThread.title migration (2026-06-21-messageThread-title.sql) to run on the DB BEFORE the rename route deploys — otherwise the backend 500s on missing column.",
    ],
    seeAlso: ["ib message chat thread", "ib message thread archive"],
    examples: [
      'ib message thread rename 3 --title "Betonijerry #42 — toimitus valmis"',
      'ib message thread rename --tarjous 23 --title ""',
    ],
  },
  {
    command: "ib message thread participant add",
    description:
      "Add a colleague to a thread (POST /api/messages/threads/:id/participants; body { personId, role? }). The person must be a member of the thread's owning company (asiakasPerson membership check — the privacy gate; cross-company adds are blocked at 403). Idempotent via MERGE (reactivates a soft-left row). Manager-gated.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      TARJOUS_THREAD_FLAG,
      { name: "person", type: "number", required: true, description: "personId to add" },
      { name: "role", type: "string", description: "Participant role (customer|pumppu|betoni|lattia|support|provider; default pumppu)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, personId, role, added:true }",
    errors: [
      TARJOUS_PARSE_ERR,
      PERSON_PARSE_ERR,
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      // Matched on the backend's own Finnish text so it is reachable past the
      // manager row above, which stays the 403 catch-all (fb#668).
      apiErr(403, "Person not in owning company", "the person must be a member of thread.ownerAsiakasId (asiakasPerson membership — privacy gate; cross-company adds are blocked)", "henkilö ei kuulu keskustelun omistajayritykseen"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MANAGER_GATED_NOTE,
      "Privacy gate: the added person must be a member of the thread's owning company (asiakasPerson JOIN). Cross-company adds are blocked at 403.",
      "Idempotent: re-adding a participant who left reactivates the row (sets leftAt = NULL) and updates role.",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldAdd:{...} } and never POSTs — works under --read-only.",
      "Deploy-gated: the participants route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread participant remove", "ib message chat thread"],
    examples: [
      "ib message thread participant add 3 --person 42",
      "ib message thread participant add 3 --person 42 --role pumppu --reason \"added to cover\"",
      "ib message thread participant add --tarjous 23 --person 42",
    ],
  },
  {
    command: "ib message thread participant remove",
    description:
      "Soft-remove a participant from a thread (DELETE /api/messages/threads/:id/participants/:personId; sets leftAt = now). Manager-gated: owning-company admin or sysadmin/developer.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      TARJOUS_THREAD_FLAG,
      { name: "person", type: "number", required: true, description: "personId to remove" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, personId, removed:true|false } (removed:false when the participant was already gone)",
    errors: [
      TARJOUS_PARSE_ERR,
      PERSON_PARSE_ERR,
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MANAGER_GATED_NOTE,
      "Soft-remove: sets leftAt = now (the row is kept for audit). removed:false when the participant had already left.",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldRemove:{...} } and never DELETEs — works under --read-only.",
      "Deploy-gated: the participants route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread participant add", "ib message chat thread"],
    examples: [
      "ib message thread participant remove 3 --person 42 --reason \"left project\"",
      "ib message thread participant remove --tarjous 23 --person 42",
    ],
  },
];
