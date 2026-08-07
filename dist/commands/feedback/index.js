import { listEnvelope } from "../../api/envelopes.js";
import { readJsonObjectInput } from "../../api/parseBody.js";
import { failWith, writeJson } from "../../output/json.js";
import { assertEnum, assertEnumCsv, parseRefId } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
const KINDS = ["improvement", "bug", "idea", "legal"];
const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "impeccable", "other"];
const STATUSES = ["open", "reviewed", "applied", "dismissed"];
const SEVERITIES = ["critical", "major", "minor", "cosmetic"];
// complexity = an AI-agent triage estimate (1-5), orthogonal to severity
// (severity = urgency/impact; complexity = effort + how autonomously an agent
// can act). 1 simple/autonomous · 2 simple/wants-input-proceeds-on-recommendation
// · 3 complex/autonomous · 4 complex/needs-user · 5 very-complex/needs-user +
// heavier model (opus/fable). See `ib help complexity`.
const COMPLEXITY_MIN = 1;
const COMPLEXITY_MAX = 5;
/** Coerce+validate a complexity estimate to an integer in [1,5]; else exit 4. */
function validateComplexity(value, flag = "--complexity") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < COMPLEXITY_MIN || n > COMPLEXITY_MAX) {
        failWith(`${flag} must be an integer ${COMPLEXITY_MIN}-${COMPLEXITY_MAX}`, 4);
    }
    return n;
}
const MAX_FREETEXT = 200;
const CAP = 200;
const TRUNCATED_FIELDS = ["description", "resolution", "errorText"];
const TRUNCATE_HINT = "description/resolution truncated to 200 chars; ib dev feedback get <id> for full text";
/**
 * Emitted whenever a complexity filter is active, because that filter's blind
 * spot is invisible in its own result.
 *
 * `complexity` is optional on `create` and most filing paths (the friction
 * auto-capture included) never set it, so the column is mostly NULL — a
 * measured 176 of 200 scope=cli rows. NULL there means "nobody estimated", but
 * a `complexity <= n` predicate excludes it as if it meant "too hard", and
 * nothing in the envelope records the omission. The flag is documented as the
 * autonomously-workable slice a batch-fix agent pulls, so the failure lands
 * exactly where it hurts: a batch that returned 21 of ~40 real candidates looks
 * like a complete answer (feedback #362 — of the four items fixed in the run
 * that found this, three were NULL-complexity and genuinely 1-2, so trusting
 * the filter would have surfaced one of four and reported the batch done).
 */
const COMPLEXITY_NULL_HINT = "a complexity filter is active and EXCLUDES rows with no estimate (complexity is optional on create, so most rows are unset — absent means unestimated, not complex); re-run without --complexity/--max-complexity to see the full candidate set";
/** Cap a string at MAX_FREETEXT chars, appending "..." when cut. Non-strings
 * pass through untouched. */
function truncateField(v) {
    if (typeof v === "string" && v.length > MAX_FREETEXT) {
        return { value: v.slice(0, MAX_FREETEXT) + "...", cut: true };
    }
    return { value: v, cut: false };
}
/** Shallow-copy a feedback row with its long free-text fields capped. */
function compactRow(row) {
    const out = { ...row };
    let cut = false;
    for (const f of TRUNCATED_FIELDS) {
        if (f in out) {
            const t = truncateField(out[f]);
            out[f] = t.value;
            if (t.cut)
                cut = true;
        }
    }
    return { row: out, cut };
}
/** Build the query string and GET a page of feedback rows (always an array). */
async function fetchRows(client, params) {
    const suffix = qs({
        status: params.status || undefined,
        kind: params.kind || undefined,
        scope: params.scope || undefined,
        search: params.search || undefined,
        complexity: params.complexity,
        maxComplexity: params.maxComplexity,
        limit: params.limit,
        offset: params.offset,
        // Oldest-first (FIFO) — the draining-loop order. Default (no flag) stays the
        // backend's newest-first, which suits human "what just broke" triage.
        orderBy: params.oldest ? "createdAt" : undefined,
        orderDirection: params.oldest ? "ASC" : undefined,
    });
    const rows = await client.get(`/api/feedback${suffix}`);
    return Array.isArray(rows) ? rows : [];
}
/**
 * Resolve the create description from the positional or its --description /
 * --body aliases (--body is the gh/git convention an agent reaches for by
 * default, and already this CLI's free-text body flag on `message chat send` —
 * feedback #278). `--title` folds in as the description's first line (there is
 * no stored title column — gh-issue-style `--title X --description Y` habit,
 * feedback #240/#241).
 */
export function resolveFeedbackCreateDescription(input) {
    const positional = input.description?.trim();
    const given = [input.descriptionFlag, input.bodyFlag]
        .map((s) => s?.trim())
        .filter((s) => !!s);
    const flagged = given[0];
    if (new Set(given).size > 1 || (positional && flagged && positional !== flagged)) {
        failWith("Provide the description once — positionally, with --description, or with --body; if several are given, they must match", 4);
    }
    const title = input.title?.trim();
    const description = positional ?? flagged;
    if (!description) {
        if (title)
            return title;
        failWith("description is required", 4);
    }
    return title ? `${title}\n\n${description}` : description;
}
/** Flags that a `--from-json` object can also supply (drives explicit-flag detection). */
export const FROM_JSON_FIELDS = [
    "description", "body", "title", "kind", "scope", "command", "error", "severity", "complexity",
];
/**
 * Merge a `--from-json` object with the CLI flags (fb#299).
 *
 * Precedence: an EXPLICITLY-typed flag wins, then the JSON object, then the
 * Commander default. That middle rung is why `explicit` is passed separately
 * from the raw opts — `--kind`/`--scope` declare defaults ("improvement"/"cli"),
 * so feeding the raw opts in would let a default the caller never typed silently
 * outrank a JSON-supplied value. Callers detect "actually typed" with
 * `cmd.getOptionValueSource(name) === "cli"` (same idiom as `keikka list`).
 */
export function mergeFeedbackCreateInput(json, explicit, defaults) {
    const s = (k) => json[k];
    return {
        description: explicit.description ?? s("description"),
        body: explicit.body ?? s("body"),
        title: explicit.title ?? s("title"),
        kind: explicit.kind ?? s("kind") ?? defaults.kind,
        scope: explicit.scope ?? s("scope") ?? defaults.scope,
        command: explicit.command ?? s("command"),
        // `errorText` is what the READ commands emit for this field, and templating
        // a --from-json file off a row from `ib dev feedback get` is the natural way
        // to author one. Here the mismatch is worse than changelog's exit-4: unknown
        // keys are simply ignored, so `errorText` would be silently DROPPED and the
        // row stored without it (feedback #357 asked for this command to be checked).
        error: explicit.error ?? s("error") ?? s("errorText"),
        severity: explicit.severity ?? s("severity"),
        complexity: explicit.complexity ?? json.complexity,
    };
}
function buildCreateBody(input) {
    const description = input.description?.trim();
    if (!description) {
        failWith("description is required", 4);
    }
    assertEnum(input.scope, SCOPES, "--scope");
    assertEnum(input.severity, SEVERITIES, "--severity");
    const body = {
        kind: KINDS.includes(input.kind) ? input.kind : "improvement",
        scope: input.scope ?? "cli",
        description,
    };
    if (input.command)
        body.command = input.command;
    if (input.error)
        body.error = input.error;
    if (input.severity)
        body.severity = input.severity;
    if (input.complexity !== undefined)
        body.complexity = validateComplexity(input.complexity);
    const convId = Number(process.env.IB_CONVERSATION_ID);
    if (Number.isInteger(convId) && convId > 0) {
        body.context = { conversationId: convId };
    }
    return body;
}
/**
 * POST /api/feedback — file a proposal / trouble report. `meta: true` exempts it
 * from the read-only write-lock. `--dry-run` prints the payload and never POSTs.
 */
export async function runFeedbackCreate(client, input) {
    const body = buildCreateBody(input);
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "POST", path: "/api/feedback", body } };
    }
    return client.post("/api/feedback", body, { meta: true });
}
/**
 * Resolve the requested status filter into a list of statuses, or null for no
 * filter (every status). With NO selector the DEFAULT is the active bucket
 * (`open` + `reviewed`) — closed items (`applied`/`dismissed`) are hidden unless
 * you ask for them. `--all` = null (every status); `--unresolved` = open +
 * reviewed; `--status` = a single value or comma-separated list. The three
 * selectors are mutually exclusive; conflicting/unknown values exit 4.
 */
function resolveStatuses(opts) {
    const selectors = [
        opts.all && "--all",
        opts.unresolved && "--unresolved",
        opts.status && "--status",
    ].filter(Boolean);
    if (selectors.length > 1) {
        failWith(`Use only one of ${selectors.join(", ")}`, 4);
    }
    if (opts.all)
        return null;
    if (opts.status) {
        const list = opts.status
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        assertEnumCsv(list, STATUSES, "--status");
        if (list.length)
            return list;
    }
    // Default (and --unresolved): the active bucket. Closed items need --all/--status.
    return ["open", "reviewed"];
}
/**
 * GET /api/feedback — developer-only. Defaults to the active bucket
 * (`open` + `reviewed`); pass `--all` for every status or `--status`/`--unresolved`
 * to filter. One status is a single server-filtered GET; the default,
 * `--unresolved`, and a CSV `--status` fan out to one GET per status, merged
 * newest-first (or oldest-first under `--oldest`) and sliced [offset,
 * offset+limit) client-side. Long free-text is capped at 200 chars unless
 * `--full`.
 */
export async function runFeedbackList(client, opts) {
    const statuses = resolveStatuses(opts);
    let items;
    let truncated = false;
    if (!statuses || statuses.length <= 1) {
        items = await fetchRows(client, {
            status: statuses?.[0],
            kind: opts.kind,
            scope: opts.scope,
            search: opts.search,
            complexity: opts.complexity,
            maxComplexity: opts.maxComplexity,
            limit: opts.limit,
            offset: opts.offset,
            oldest: opts.oldest,
        });
    }
    else {
        const pages = await Promise.all(statuses.map((s) => fetchRows(client, {
            status: s,
            kind: opts.kind,
            scope: opts.scope,
            search: opts.search,
            complexity: opts.complexity,
            maxComplexity: opts.maxComplexity,
            limit: CAP,
            oldest: opts.oldest,
        })));
        if (pages.some((p) => p.length >= CAP))
            truncated = true;
        // feedbackId is monotonic with createdAt, so it doubles as the merge key.
        // dir = +1 oldest-first (ASC), -1 newest-first (DESC, the default).
        const dir = opts.oldest ? 1 : -1;
        const merged = pages
            .flat()
            .sort((a, b) => dir * (Number(a.feedbackId) - Number(b.feedbackId)));
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? 50;
        if (merged.length > offset + limit)
            truncated = true;
        items = merged.slice(offset, offset + limit);
    }
    let cut = false;
    if (!opts.full) {
        items = items.map((r) => {
            const c = compactRow(r);
            if (c.cut)
                cut = true;
            return c.row;
        });
    }
    const env = listEnvelope(items);
    if (truncated)
        env.truncated = true;
    const hints = [];
    if (cut)
        hints.push(TRUNCATE_HINT);
    if (opts.complexity !== undefined || opts.maxComplexity !== undefined)
        hints.push(COMPLEXITY_NULL_HINT);
    if (hints.length)
        env.hint = hints.join("; ");
    return env;
}
/** GET /api/feedback/:id — developer-only single row. */
export async function runFeedbackGet(client, id) {
    return client.get(`/api/feedback/${id}`);
}
/**
 * Client-side aggregate of /api/feedback for the cheapest "is there anything?"
 * answer. Fetches up to the 200-row cap (optionally pre-filtered by
 * kind/scope) and buckets by status/kind/scope. Flags `truncated` if the table
 * exceeds the cap (won't happen at current row counts; kept honest).
 */
export async function runFeedbackCount(client, opts) {
    const rows = await fetchRows(client, { kind: opts.kind, scope: opts.scope, limit: CAP });
    const byStatus = { open: 0, reviewed: 0, applied: 0, dismissed: 0 };
    const byKind = {};
    const byScope = {};
    for (const r of rows) {
        const s = String(r.status ?? "");
        if (s in byStatus)
            byStatus[s] += 1;
        const k = String(r.kind ?? "unknown");
        byKind[k] = (byKind[k] ?? 0) + 1;
        const sc = String(r.scope ?? "unknown");
        byScope[sc] = (byScope[sc] ?? 0) + 1;
    }
    const out = { total: rows.length, byStatus, byKind, byScope };
    if (rows.length >= CAP) {
        out.truncated = true;
        out.hint = "count is a lower bound — fetch hit the 200-row cap";
    }
    return out;
}
/** Project a resolved row to the compact write-ack fields (resolution capped). */
function compactAck(row) {
    const ack = {};
    for (const k of ["feedbackId", "status", "updatedAt"]) {
        if (k in row)
            ack[k] = row[k];
    }
    if ("resolution" in row)
        ack.resolution = truncateField(row.resolution).value;
    return ack;
}
/** Fields a `resolve --from-json` object may supply (drives explicit-flag detection). */
export const RESOLVE_FROM_JSON_FIELDS = ["status", "note", "reason", "resolution"];
/**
 * Merge a `resolve --from-json` object with the CLI flags (feedback #327).
 *
 * Same precedence as `create`: an explicitly-typed flag wins over the JSON.
 * `resolve` has no Commander defaults, so there is no third rung — an absent
 * flag is simply absent. The three note aliases are merged AFTER the merge, so
 * a note supplied in JSON and a different one typed on argv are both kept,
 * exactly as `mergeNoteFlags` does for three argv flags.
 */
export function mergeFeedbackResolveInput(json, explicit) {
    const pick = (k) => {
        const v = explicit[k] ?? json[k];
        return v === undefined || v === null ? undefined : String(v);
    };
    return {
        status: pick("status"),
        note: mergeNoteFlags(pick("note"), pick("resolution"), pick("reason")),
    };
}
/**
 * --note / --reason / --resolution are aliases for the same stored note. When a
 * caller passes more than one with DIFFERENT values — natural for an AI, since
 * --reason means the X-Action-Reason audit header on every other write command —
 * keep them all (joined), instead of silently dropping all but one (feedback #216).
 */
export function mergeNoteFlags(...values) {
    const distinct = [...new Set(values.filter((v) => v !== undefined))];
    return distinct.length ? distinct.join("\n\n") : undefined;
}
/**
 * PUT /api/feedback/:id — developer triage (status and/or resolution note).
 * A REAL write — blocked under --read-only (exit 3). `--dry-run` previews the
 * body client-side without sending.
 *
 * A note-only call (no --status) does NOT close the row — the name "resolve"
 * primes callers to assume it does, so when the row comes back still
 * open/reviewed the ack carries a `hint` naming the closing statuses
 * (feedback #270). An explicit `--status open|reviewed` is a deliberate
 * choice — no hint.
 */
export async function runFeedbackResolve(client, id, input) {
    assertEnum(input.status, STATUSES, "--status");
    if (input.status === undefined && input.note === undefined) {
        failWith("Provide --status and/or --note", 4);
    }
    const body = {};
    if (input.status !== undefined)
        body.status = input.status;
    if (input.note !== undefined)
        body.resolution = input.note;
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
    }
    const row = await client.put(`/api/feedback/${id}`, body);
    const out = input.full ? { ...row } : compactAck(row);
    if (input.status === undefined && (row.status === "open" || row.status === "reviewed")) {
        out.hint = `status unchanged (${row.status}) - pass --status applied|dismissed to close`;
    }
    return out;
}
/** Project an updated row to the compact edit-ack fields (description capped). */
function compactUpdateAck(row) {
    const ack = {};
    for (const k of ["feedbackId", "scope", "kind", "severity", "complexity", "updatedAt"]) {
        if (k in row)
            ack[k] = row[k];
    }
    if ("description" in row)
        ack.description = truncateField(row.description).value;
    return ack;
}
/** Fields an `update --from-json` object may supply (drives explicit-flag detection). */
export const UPDATE_FROM_JSON_FIELDS = [
    "scope", "kind", "severity", "complexity", "description", "body", "appendDescription",
];
/**
 * Merge an `update --from-json` object with the CLI flags (feedback #332).
 * Explicitly-typed flags win; `update` declares no Commander defaults, so an
 * absent flag is simply absent. `body` folds into `description` (its alias)
 * exactly as the argv path does.
 */
export function mergeFeedbackUpdateInput(json, explicit) {
    const pick = (k) => explicit[k] ?? json[k];
    const str = (v) => v === undefined || v === null ? undefined : String(v);
    const description = str(pick("description")) ?? str(pick("body"));
    const complexityRaw = pick("complexity");
    return {
        scope: str(pick("scope")),
        kind: str(pick("kind")),
        severity: str(pick("severity")),
        complexity: complexityRaw === undefined || complexityRaw === null ? undefined : Number(complexityRaw),
        description,
        appendDescription: str(pick("appendDescription")),
    };
}
/**
 * PUT /api/feedback/:id — developer edit of a filed row's classification
 * (scope/kind/severity) or description; the correction twin of `resolve`
 * (which sets status/note), same endpoint. A REAL write — blocked under
 * --read-only (exit 3). `--dry-run` previews the body client-side. Deploy-gated:
 * an older backend ignores these fields and 400s on a status-less body.
 */
export async function runFeedbackUpdate(client, id, input) {
    assertEnum(input.scope, SCOPES, "--scope");
    assertEnum(input.kind, KINDS, "--kind");
    assertEnum(input.severity, SEVERITIES, "--severity");
    if (input.description !== undefined && !input.description.trim()) {
        failWith("--description must be non-empty", 4);
    }
    if (input.appendDescription !== undefined && !input.appendDescription.trim()) {
        failWith("--append-description must be non-empty", 4);
    }
    // Replace and append are opposite intents on the same field — accepting both
    // would silently pick one. Exit 4 rather than guess (mirrors the glossary
    // `--definition` vs `--append-definition` pairing).
    if (input.description !== undefined && input.appendDescription !== undefined) {
        failWith("--description and --append-description are mutually exclusive", 4);
    }
    const body = {};
    if (input.scope !== undefined)
        body.scope = input.scope;
    if (input.kind !== undefined)
        body.kind = input.kind;
    if (input.severity !== undefined)
        body.severity = input.severity;
    if (input.complexity !== undefined)
        body.complexity = validateComplexity(input.complexity);
    if (input.description !== undefined)
        body.description = input.description.trim();
    // Read-merge-write: --description REPLACES the filed report, which is the
    // destructive half of feedback #332. Appending keeps the original text and
    // adds to it, so later commentary can never overwrite the evidence.
    if (input.appendDescription !== undefined) {
        const current = await runFeedbackGet(client, id);
        const existing = typeof current.description === "string" ? current.description : "";
        const addition = input.appendDescription.trim();
        body.description = existing ? `${existing.trimEnd()}\n\n${addition}` : addition;
    }
    if (Object.keys(body).length === 0) {
        failWith("Provide at least one of --scope / --kind / --severity / --complexity / --description / --append-description", 4);
    }
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
    }
    const row = await client.put(`/api/feedback/${id}`, body);
    return input.full ? row : compactUpdateAck(row);
}
/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; status/note write)
 *   update   PUT  /api/feedback/:id (developer-only; scope/kind/severity/description edit)
 */
export function registerFeedbackCommands(parent, getClient, opts = {}) {
    const f = parent
        .command("feedback", { hidden: !!opts.hidden })
        .description("File & triage CLI improvement proposals / trouble reports");
    f.command("create [description]")
        // `add` — hidden alias: an agent fresh off `ib dev changelog add` (the lone
        // group using `add` to create a top-level entry) naturally types
        // `feedback add`; accept it instead of dead-ending on exit 4 (feedback #229).
        .alias("add")
        .option("--description <text>", "Alias for the positional description")
        .option("--body <text>", "Alias for --description (free text, not JSON); if several are given, they must match")
        .option("--title <text>", "Optional title, folded into the description as its first line (no stored title column)")
        .option("--kind <kind>", "improvement | bug | idea | legal", "improvement")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other — product surface this feedback targets (impeccable = auto-piped design-hook findings)", "cli")
        .option("--command <argv>", "The ib command/argv that triggered the friction")
        .option("--error <msg>", "Error message you hit, if any")
        .option("--severity <sev>", "critical | major | minor | cosmetic (optional; most useful for --kind bug)")
        .option("--complexity <n>", "1-5 agent-triage estimate: 1 simple+autonomous · 2 simple+wants-input · 3 complex+autonomous · 4 complex+needs-user · 5 very-complex+needs-user & heavier model (see `ib help complexity`)", Number)
        .option("--from-json <file>", "Read the whole payload from a JSON object file (or - for stdin); explicit flags override. Shell-safe: the only way to pass text containing quotes on Windows PowerShell.")
        .option("--dry-run", "Print the payload without sending (client-side)")
        .action(guarded(async (description, opts, cmd) => {
        // Only the flags the caller ACTUALLY typed outrank the JSON object —
        // see mergeFeedbackCreateInput (--kind/--scope carry defaults).
        const explicit = {};
        for (const k of FROM_JSON_FIELDS) {
            if (cmd.getOptionValueSource(k) === "cli")
                explicit[k] = opts[k];
        }
        const merged = mergeFeedbackCreateInput(opts.fromJson ? readJsonObjectInput(opts.fromJson) : {}, explicit, { kind: opts.kind, scope: opts.scope });
        const client = await getClient();
        writeJson(await runFeedbackCreate(client, {
            description: resolveFeedbackCreateDescription({
                description,
                descriptionFlag: merged.description,
                bodyFlag: merged.body,
                title: merged.title,
            }),
            kind: merged.kind,
            scope: merged.scope,
            command: merged.command,
            error: merged.error,
            severity: merged.severity,
            complexity: merged.complexity,
            dryRun: opts.dryRun,
        }));
    }));
    f.command("list")
        .option("--status <status>", "open | reviewed | applied | dismissed (or a comma-separated list, e.g. open,reviewed)")
        .option("--unresolved", "Shortcut for --status open,reviewed (un-closed items) — same as the default")
        .option("--all", "Include every status (open,reviewed,applied,dismissed); overrides the open+reviewed default")
        .option("--full", "Return untruncated description/resolution (default: capped at 200 chars)")
        .option("--kind <kind>", "improvement | bug | idea | legal")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other")
        .option("--search <text>", "Substring match over description/command/resolution/errorText (deploy-gated)")
        .option("--complexity <n>", "Only items with this exact complexity (1-5). ⚠ EXCLUDES rows with no estimate, which is most of the table — absent means unestimated, not complex.", Number)
        .option("--max-complexity <n>", "Only items with complexity <= n — the autonomously-workable slice (deploy-gated). ⚠ EXCLUDES rows with no estimate, which is most of the table — absent means unestimated, not complex.", Number)
        .option("--oldest", "Oldest-first (createdAt ASC) — FIFO drain order for the triage loop; default is newest-first")
        .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
        .option("--offset <n>", "Pagination offset", Number)
        .action(jsonAction(getClient, (client, opts) => runFeedbackList(client, opts)));
    f.command("get <id>")
        .option("--full", "Accepted for cross-command consistency; get always returns the full row (no-op)")
        .action(guarded(async (idStr) => {
        const id = parseRefId(idStr, "feedback", "get");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackGet(client, id)));
    }));
    f.command("resolve <id>")
        .option("--status <status>", "open | reviewed | applied | dismissed")
        .option("--note <text>", "Resolution note stored on the row")
        .option("--reason <text>", "Alias for --note — here it IS the stored note, NOT the X-Action-Reason audit header")
        .option("--resolution <text>", "Alias for --note (matches the output field name); distinct values across the three note flags are merged into one note")
        .option("--from-json <file>", "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: status, note (or reason/resolution). Shell-safe: the only way to pass a note containing quotes on Windows PowerShell.")
        .option("--dry-run", "Print the update body without sending (client-side)")
        .option("--full", "Return the full updated row (default: a compact ack)")
        .action(guarded(async (idStr, opts, cmd) => {
        const id = parseRefId(idStr, "feedback", "resolve");
        // Only EXPLICITLY-typed flags outrank the JSON object (feedback #327).
        const explicit = {};
        for (const k of RESOLVE_FROM_JSON_FIELDS) {
            if (cmd.getOptionValueSource(k) === "cli") {
                explicit[k] = opts[k];
            }
        }
        const merged = mergeFeedbackResolveInput(opts.fromJson ? readJsonObjectInput(opts.fromJson) : {}, explicit);
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackResolve(client, id, {
            status: merged.status,
            note: merged.note,
            dryRun: opts.dryRun,
            full: opts.full,
        })));
    }));
    f.command("update <id>")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other")
        .option("--kind <kind>", "improvement | bug | idea | legal")
        .option("--severity <sev>", "critical | major | minor | cosmetic")
        .option("--complexity <n>", "1-5 agent-triage estimate — promote/downgrade after investigation (see `ib help complexity`)", Number)
        .option("--description <text>", "REPLACE the freetext description (destructive — the filed report is overwritten; use --append-description to add to it)")
        .option("--body <text>", "Alias for --description (free text, not JSON); if both are given, they must match")
        .option("--append-description <text>", "Append to the CURRENT description (read-merge-write, separated by a blank line) — keeps the original report intact")
        .option("--from-json <file>", "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: scope, kind, severity, complexity, description (or body), appendDescription. Shell-safe: the only way to pass prose containing quotes on Windows PowerShell.")
        .option("--dry-run", "Print the update body without sending (client-side)")
        .option("--full", "Return the full updated row (default: a compact ack)")
        .action(guarded(async (idStr, opts, cmd) => {
        const id = parseRefId(idStr, "feedback", "update");
        // --body is an alias for --description (feedback #278); fold it in so
        // runFeedbackUpdate sees one field. Both only when they agree.
        if (opts.body !== undefined) {
            if (opts.description !== undefined && opts.description.trim() !== opts.body.trim())
                failWith("Provide the description via --description or --body, not both with different values", 4);
            if (opts.description === undefined)
                opts.description = opts.body;
        }
        // Only EXPLICITLY-typed flags outrank the JSON object (feedback #332).
        const explicit = {};
        for (const k of UPDATE_FROM_JSON_FIELDS) {
            if (cmd.getOptionValueSource(k) === "cli") {
                explicit[k] = opts[k];
            }
        }
        // --body typed on argv resolves to description above, so carry it over
        // as the explicit description rather than losing it to the JSON.
        if (explicit.body !== undefined && explicit.description === undefined) {
            explicit.description = opts.description;
        }
        const merged = mergeFeedbackUpdateInput(opts.fromJson ? readJsonObjectInput(opts.fromJson) : {}, explicit);
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackUpdate(client, id, { ...merged, dryRun: opts.dryRun, full: opts.full })));
    }));
    f.command("count")
        .option("--kind <kind>", "improvement | bug | idea | legal")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other")
        .action(jsonAction(getClient, (client, opts) => runFeedbackCount(client, opts)));
}
//# sourceMappingURL=index.js.map