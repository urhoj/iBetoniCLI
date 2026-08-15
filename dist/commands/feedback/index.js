/**
 * `ib feedback` — file and triage CLI improvement proposals / trouble reports.
 *
 * When an AI (or CI) hits friction using `ib`, it files a freetext note here so
 * the CLI can be improved. Submission is QUIET (no GitHub issue, no spam to you
 * or the user — distinct from `bugReport`); the maintainer gets a private
 * heads-up email. A developer-gated analyzer skill reads them back via
 * `ib dev feedback list` and closes the loop.
 *
 * `create` is sent as a META request → exempt from the read-only write-lock, so
 * an agent running `--read-only` can still report friction. `list`/`get`/`resolve`
 * are developer-only; `resolve` is a real write (blocked under read-only).
 * `--dry-run` (create + resolve) resolves CLIENT-SIDE: prints the payload, no send.
 */
import os from "node:os";
import { listEnvelope } from "../../api/envelopes.js";
import { FEEDBACK_LIST_CAP, FEEDBACK_LIST_DEFAULT, warnIfLimitCapped, } from "../../api/listCaps.js";
import { failWith, warnNote, writeJson } from "../../output/json.js";
import { assertEnum, assertEnumCsv, parseRefId } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { foldAliases, warnIfShellMangled } from "../_shared/flags.js";
import { applyFromJson } from "../_shared/fromJson.js";
import { qs } from "../../api/query.js";
import { getEmbeddedCtx } from "../../embedded.js";
import { CliError } from "../../api/errors.js";
import { writeFlagsToHeaders } from "../../api/writeFlags.js";
// Exported for specs.ts: the spec flags declare these as machine-readable
// `allowed:` sets (validation envelopes), single-sourced from here.
export const KINDS = ["improvement", "bug", "idea", "legal"];
export const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "impeccable", "other"];
export const STATUSES = ["open", "reviewed", "applied", "dismissed"];
export const SEVERITIES = ["critical", "major", "minor", "cosmetic"];
/**
 * The OTHER severity vocabulary — high/medium/low is what issue trackers and
 * most AI tooling use, so it is the natural first guess here and too far from
 * ours for edit distance to bridge (`high`→`major` is 5 edits). Mapped to a
 * `did you mean` hint on the exit-4 message, NOT accepted as an alias: this
 * command's whole contract is that an unknown enum value is reported, never
 * quietly rewritten (feedback #369).
 */
const SEVERITY_SYNONYMS = {
    high: "major",
    medium: "minor",
    low: "cosmetic",
    blocker: "critical",
    trivial: "cosmetic",
};
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
/**
 * The server's row cap. Was a local literal duplicating the backend constant,
 * and was applied ONLY on the multi-status merge path below — the single-status
 * path (which `--all` takes) never set `truncated` at all, so `--limit 1000`
 * answered 200 rows of 604 and looked complete (fb#605). Now one shared mirror.
 */
const CAP = FEEDBACK_LIST_CAP;
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
const COMPLEXITY_NULL_HINT = "a complexity filter is active and EXCLUDES rows with no estimate (complexity is optional on create, so most rows are unset — absent means unestimated, not complex); re-run without --complexity/--max-complexity to see the full candidate set, or with --complexity none to see ONLY the unestimated rows";
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
        // The backend's truthy set is EXACTLY "1"/"true" (deliberately, so
        // ?unclaimed=false can't filter as if true) — send the literal "1", not a
        // stringified boolean shortcut that might drift from that contract.
        unclaimed: params.unclaimed ? "1" : undefined,
        claimedBy: params.claimedBy || undefined,
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
    const description = foldAliases([input.description, input.descriptionFlag, input.bodyFlag], "Provide the description once — positionally, with --description, or with --body; if several are given, they must match");
    const title = input.title?.trim();
    if (!description) {
        if (title)
            return title;
        failWith("description is required", 4);
    }
    return title ? `${title}\n\n${description}` : description;
}
/**
 * `create`'s `--from-json` config — the shared pipeline (_shared/fromJson.ts)
 * derives the accepted keys from the command's own registered flags, rejects
 * unknown/wrong-typed keys aggregated (exit 4 — the fb#298 silent-drop class is
 * gone), and merges explicit flag > JSON > Commander default (fb#299: --kind/
 * --scope declare defaults, which must not outrank a JSON-supplied value).
 *
 * readShapeAliases: `errorText` is what the READ commands emit for the --error
 * field, and templating a --from-json file off a row from `ib dev feedback get`
 * is the natural way to author one (feedback #357).
 */
const CREATE_FROM_JSON = {
    nonPayload: new Set(["fromJson", "dryRun", "help"]),
    readShapeAliases: { errorText: "error" },
    numericFields: new Set(["complexity"]),
};
function buildCreateBody(input) {
    const description = input.description?.trim();
    if (!description) {
        failWith("description is required", 4);
    }
    // All three enums are STRICT (feedback #369). --kind used to fall back to
    // "improvement" on an unknown value while its two siblings — and `update`'s
    // own --kind — exited 4, so a bug filed as `--kind bugs` was silently
    // relabelled an improvement and returned a success + feedbackId: the caller
    // moved on and the row was mis-triaged with nothing recording the rewrite.
    assertEnum(input.kind, KINDS, "--kind");
    assertEnum(input.scope, SCOPES, "--scope");
    assertEnum(input.severity, SEVERITIES, "--severity", SEVERITY_SYNONYMS);
    const body = {
        kind: input.kind ?? "improvement",
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
 * Classify one row's lease against the caller.
 *
 * An EXPIRED claim is "free", not "held" — the lease invariant is evaluated
 * against the clock at read time, never against a stored flag. Rendering a
 * lapsed lease as "held" would hide exactly the rows the 24h reclamation frees.
 */
export function deriveClaimState(row, me) {
    const by = row.claimedBy;
    const until = row.claimExpiresAt;
    if (typeof by !== "string" || !by)
        return "free";
    // A malformed/unparseable claimExpiresAt must degrade toward FREE, not HELD:
    // `new Date(garbage).getTime()` is NaN, and `NaN <= Date.now()` is false, so
    // an unguarded comparison would fall through to "held"/"mine" — the opposite
    // of this feature's whole premise, that a lease can never get permanently
    // stuck. Corrupt data is exactly the case the clock-based check exists for.
    const t = new Date(String(until)).getTime();
    if (!until || Number.isNaN(t) || t <= Date.now())
        return "free";
    return by === me ? "mine" : "held";
}
/**
 * GET /api/feedback — developer-only. Defaults to the active bucket
 * (`open` + `reviewed`); pass `--all` for every status or `--status`/`--unresolved`
 * to filter. One status is a single server-filtered GET; the default,
 * `--unresolved`, and a CSV `--status` fan out to one GET per status, merged
 * newest-first (or oldest-first under `--oldest`) and sliced [offset,
 * offset+limit) client-side. Long free-text is capped at 200 chars unless
 * `--full`.
 *
 * `--kind`/`--scope` are validated here for the same reason `create` validates
 * them (feedback #369): both are forwarded to the server as SQL filters, so an
 * unknown value returns an empty list — which reads as "nothing is filed under
 * that kind", not "you typed a kind that does not exist".
 *
 * Claim filters (`--unclaimed` / `--mine` / `--claimed-by`) are mutually
 * exclusive — each answers a different question ("what can I pick up" vs
 * "what do I hold" vs "what does labelX hold") and combining them has no
 * coherent meaning. Every returned row also carries a derived `claimState`
 * (see `deriveClaimState`) regardless of which filter (if any) was used.
 */
export async function runFeedbackList(client, opts) {
    assertEnum(opts.kind, KINDS, "--kind");
    assertEnum(opts.scope, SCOPES, "--scope");
    const claimFilters = [opts.unclaimed, opts.mine, opts.claimedBy].filter(Boolean).length;
    if (claimFilters > 1) {
        failWith("Use only one of --unclaimed / --mine / --claimed-by", 4);
    }
    const me = resolveClaimId(undefined);
    const claimedBy = opts.mine ? me : opts.claimedBy;
    const statuses = resolveStatuses(opts);
    let items;
    let truncated = false;
    warnIfLimitCapped(opts.limit, CAP, "ib dev feedback list");
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
            unclaimed: opts.unclaimed,
            claimedBy,
        });
        // The path the merge branch below already covered, and this one did not:
        // a FULL page means more rows exist. The effective limit is min(requested,
        // CAP) — checking against the RAW request is what missed the case, since
        // asking for 1000 and receiving 200 fails `items.length >= 1000` (fb#605).
        const effective = Math.min(opts.limit ?? FEEDBACK_LIST_DEFAULT, CAP);
        if (client.getLastListMeta?.()?.truncated || items.length >= effective)
            truncated = true;
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
            unclaimed: opts.unclaimed,
            claimedBy,
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
    items = items.map((r) => ({ ...r, claimState: deriveClaimState(r, me) }));
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
 * Aggregate counts, server-side over the WHOLE table (GET /api/feedback/stats).
 *
 * This used to bucket a client-side page in JS, which was correct only while the
 * table stayed under the 200-row cap. It didn't: the page is newest-first, so
 * truncation dropped the OLDEST rows — the longest-neglected backlog, the worst
 * possible bias for a "how much is still open?" number — and a command whose
 * entire purpose is producing counts returned wrong ones by default (fb#536,
 * measured: byStatus.open 87 vs a true 91). The docstring's old parenthetical
 * ("won't happen at current row counts") is exactly the kind of assumption
 * nothing re-checks; it had silently expired.
 *
 * DEPLOY-GATED with a graceful fallback: against a backend without the route we
 * fall back to the old rollup and keep its `truncated`/`hint` caveat, so the
 * command degrades to its previous behaviour rather than breaking outright.
 *
 * The fallback deliberately does NOT key off a single status. An older backend
 * has no /stats path, so the request falls through to `GET /:id` as id="stats" —
 * which, before that route learned to reject a non-numeric id, reached SQL and
 * came back 500 ("Conversion failed when converting the nvarchar value 'stats'")
 * rather than 404. Verified against prod. Auth and permission errors still
 * propagate: they are actionable, and the fallback call would fail the same way.
 */
export async function runFeedbackCount(client, opts) {
    // Same silent-empty trap as `list` — here it reads as a total of 0 (fb#369).
    assertEnum(opts.kind, KINDS, "--kind");
    assertEnum(opts.scope, SCOPES, "--scope");
    const suffix = qs({ kind: opts.kind || undefined, scope: opts.scope || undefined });
    try {
        return await client.get(`/api/feedback/stats${suffix}`);
    }
    catch (e) {
        const status = e instanceof CliError ? e.statusCode : 0;
        if (status === 401 || status === 403)
            throw e;
        return countClientSide(client, opts);
    }
}
/** Pre-fb#536 rollup: bucket one capped page in JS. Only reached on an older backend. */
async function countClientSide(client, opts) {
    const rows = await fetchRows(client, { kind: opts.kind, scope: opts.scope, limit: CAP });
    const byStatus = { open: 0, reviewed: 0, applied: 0, dismissed: 0 };
    const byKind = {};
    const byScope = {};
    let unestimated = 0;
    for (const r of rows) {
        const s = String(r.status ?? "");
        if (s in byStatus)
            byStatus[s] += 1;
        const k = String(r.kind ?? "unknown");
        byKind[k] = (byKind[k] ?? 0) + 1;
        const sc = String(r.scope ?? "unknown");
        byScope[sc] = (byScope[sc] ?? 0) + 1;
        if (r.complexity == null)
            unestimated += 1;
    }
    const out = { total: rows.length, byStatus, byKind, byScope, unestimated };
    if (rows.length >= CAP) {
        out.truncated = true;
        out.hint =
            "count is a lower bound — this backend has no /api/feedback/stats, so the rollup ran client-side and hit the 200-row cap. The rows dropped are the OLDEST, so `open` is understated most.";
    }
    return out;
}
/**
 * PUT /api/feedback/:id responses may carry an advisory `warning` when the
 * write just landed on a row another agent currently holds under a LIVE
 * claim lease (the lease never blocks a write, only warns — feedback #585).
 * Printed to stderr exactly once per call regardless of `--full`: it is a
 * safety signal, not a verbosity detail, so it must reach the caller even in
 * compact mode. Never stdout — the JSON data contract stays untouched.
 */
function warnClaimAdvisory(row) {
    if (typeof row.warning === "string" && row.warning) {
        warnNote(`[ib] ⚠ ${row.warning}`);
    }
}
/**
 * Project a resolved row to the compact write-ack fields (resolution capped).
 * `warning` (the claim-lease advisory — see {@link warnClaimAdvisory}) rides
 * through even in compact mode: it is a safety signal, not verbosity.
 */
function compactAck(row) {
    const ack = {};
    for (const k of ["feedbackId", "status", "updatedAt"]) {
        if (k in row)
            ack[k] = row[k];
    }
    if ("resolution" in row)
        ack.resolution = truncateField(row.resolution).value;
    if ("warning" in row)
        ack.warning = row.warning;
    return ack;
}
/**
 * `resolve`'s `--from-json` config (feedback #327) — the shared pipeline with
 * no Commander defaults, so the precedence collapses to explicit flag > JSON.
 * The three note aliases (--note/--reason/--resolution) are merged AFTER the
 * per-key merge via {@link mergeNoteFlags}, so a note supplied in JSON and a
 * different one typed on argv are both kept, exactly as for three argv flags.
 * Unknown/wrong-typed JSON keys exit 4 (shared contract, fb#298 class).
 */
const RESOLVE_FROM_JSON = {
    nonPayload: new Set(["fromJson", "dryRun", "full", "help"]),
};
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
    const row = await client.put(`/api/feedback/${id}`, body, {
        headers: { "x-claim-id": resolveClaimId(undefined) },
    });
    warnClaimAdvisory(row);
    const out = input.full ? { ...row } : compactAck(row);
    if (input.status === undefined && (row.status === "open" || row.status === "reviewed")) {
        out.hint = `status unchanged (${row.status}) - pass --status applied|dismissed to close`;
    }
    return out;
}
/**
 * Project an updated row to the compact edit-ack fields (description capped).
 * `warning` (the claim-lease advisory — see {@link warnClaimAdvisory}) rides
 * through even in compact mode: it is a safety signal, not verbosity.
 */
function compactUpdateAck(row) {
    const ack = {};
    for (const k of ["feedbackId", "scope", "kind", "severity", "complexity", "updatedAt"]) {
        if (k in row)
            ack[k] = row[k];
    }
    if ("description" in row)
        ack.description = truncateField(row.description).value;
    if ("warning" in row)
        ack.warning = row.warning;
    return ack;
}
/**
 * `update`'s `--from-json` config (feedback #332) — the shared pipeline with no
 * Commander defaults, so the precedence collapses to explicit flag > JSON.
 * `body` (JSON or argv) folds into `description` AFTER the merge via
 * {@link foldAliases}, mirroring `changelog update` — differing values across
 * the two spellings exit 4 instead of one silently winning. Unknown/wrong-typed
 * JSON keys exit 4 (shared contract, fb#298 class).
 */
const UPDATE_FROM_JSON = {
    nonPayload: new Set(["fromJson", "dryRun", "full", "help"]),
    numericFields: new Set(["complexity"]),
};
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
    assertEnum(input.severity, SEVERITIES, "--severity", SEVERITY_SYNONYMS);
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
    const row = await client.put(`/api/feedback/${id}`, body, {
        headers: { "x-claim-id": resolveClaimId(undefined) },
    });
    warnClaimAdvisory(row);
    return input.full ? row : compactUpdateAck(row);
}
/** Column width of cliFeedback.claimedBy — labels are capped to match. */
const CLAIM_LABEL_MAX = 120;
/**
 * Resolve the claiming agent's label — the identity mechanism `runFeedbackClaim`
 * / `runFeedbackRelease` key mutual exclusion on, and that `runFeedbackResolve` /
 * `runFeedbackUpdate` echo back as `x-claim-id` so the backend can tell a
 * writer's own claim apart from someone else's.
 *
 * Every agent authenticates as the SAME person (personId 10), so the backend
 * cannot tell two sessions apart — the label is the only thing that can.
 * **`$IB_CLAIM_ID` is the PRIMARY mechanism**: set it once per session/cron/
 * Hermes run and every command that touches claims (claim, release, and the
 * `x-claim-id` header on resolve/update) agrees on who is who, with nothing to
 * remember per call. `--by` is a per-command OVERRIDE for a one-off call —
 * `resolve`/`update` have no `--by` flag at all, so an agent that identifies
 * itself only via `--by` on `claim` will mismatch on the `x-claim-id` header
 * sent by `resolve`/`update` and get warned about its own claim. Order:
 * explicit --by, then the embedded ctx (in-process hosted calls), then
 * IB_CLAIM_ID (Hermes / cron / CI / the spawned hosted child), then user@host as
 * a coarse machine-level fallback that is never empty.
 *
 * The ctx read comes BEFORE the env read for the same reason `tier` is ctx-aware
 * (fb#616): interleaved in-process calls share one `process.env`, so an env-only
 * lookup would hand every concurrent hosted caller the same label — and a lease
 * whose holders are indistinguishable does not lock anything.
 */
export function resolveClaimId(explicit) {
    const v = explicit ?? getEmbeddedCtx()?.claimId ?? process.env.IB_CLAIM_ID;
    if (v && v.trim())
        return v.trim().slice(0, CLAIM_LABEL_MAX);
    let user = "unknown";
    try {
        user = os.userInfo().username;
    }
    catch {
        // os.userInfo() throws on some locked-down containers; the host half is
        // still a useful discriminator, so degrade rather than fail the command.
    }
    return `${user}@${os.hostname()}`.slice(0, CLAIM_LABEL_MAX);
}
/** POST /api/feedback/:id/claim — take or renew the lease. A REAL write. */
/**
 * Refuse to key a lease on an identity the backend cannot tell callers apart by
 * (fb#616).
 *
 * The hosted bridge sets IB_CLAIM_ID_SHARED=1 when it could not derive a
 * per-caller label, because on that path the CLI's own `user@host` fallback
 * resolves to the App Service container — ONE identical label for every hosted
 * caller. Two agents then both match `claimedBy = @by`, both take the renewal
 * branch, and both get 200: the lock is ABSENT, not merely weak, and both
 * believe they hold the row.
 *
 * So this fails closed rather than warning. A refused claim costs one round trip
 * and a flag; an accepted-but-shared claim costs two agents doing the same work
 * and finding out from the diff.
 *
 * Only guards the two commands whose whole purpose is exclusivity. Reads
 * (`list --mine`) and advisory writes (resolve/update) stay usable — they
 * degrade to a wrong-but-harmless label, and blocking them would strand work
 * behind an identity problem.
 */
function assertClaimIdentity(explicit, action) {
    if (explicit || getEmbeddedCtx()?.claimId || process.env.IB_CLAIM_ID)
        return;
    if (process.env.IB_CLAIM_ID_SHARED !== "1")
        return;
    failWith(`cannot ${action}: this backend could not derive a per-caller identity, so the claim would be keyed on a label SHARED by every hosted caller — it would not actually lock the row. ` +
        `Pass --by <label> (a stable id for THIS agent, e.g. an agent/session name), or set IB_CLAIM_ID before invoking.`, 4);
}
export async function runFeedbackClaim(client, id, input) {
    assertClaimIdentity(input.by, "claim");
    const body = { by: resolveClaimId(input.by) };
    if (input.ttlHours !== undefined)
        body.ttlHours = input.ttlHours;
    if (input.steal)
        body.steal = true;
    return client.post(`/api/feedback/${id}/claim`, body, {
        headers: writeFlagsToHeaders({ reason: input.reason }),
    });
}
/** Release one lease (DELETE) or every lease held by the label (--all). */
export async function runFeedbackRelease(client, id, input) {
    // --all only: a shared label would release every hosted caller's claims, not
    // just this one's. Releasing a SINGLE named id is safe either way.
    if (input.all)
        assertClaimIdentity(input.by, "release --all");
    const by = resolveClaimId(input.by);
    const headers = writeFlagsToHeaders({ reason: input.reason });
    const hasReason = Object.keys(headers).length > 0;
    if (input.all) {
        return hasReason
            ? client.post("/api/feedback/claims/release", { by }, { headers })
            : client.post("/api/feedback/claims/release", { by });
    }
    if (id == null)
        failWith("Provide a feedbackId, or --all to release every claim", 4);
    // ⚠ `ApiClient.delete` is `(path, opts?: FetchOptions)` and FetchOptions has NO
    // `body` field — passing `{ by }` as the second argument would be read as fetch
    // options and the label would never reach the backend, which would then 400.
    // The label therefore rides in the query string; the controller reads
    // `req.body?.by ?? req.query?.by`.
    const path = `/api/feedback/${id}/claim?by=${encodeURIComponent(by)}`;
    return hasReason
        ? client.delete(path, { headers })
        : client.delete(path);
}
/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; status/note write)
 *   update   PUT  /api/feedback/:id (developer-only; scope/kind/severity/description edit)
 *   claim    POST /api/feedback/:id/claim (developer-only; take/renew the work lease)
 *   release  DELETE /api/feedback/:id/claim, or POST /api/feedback/claims/release --all
 *            (developer-only; release the work lease)
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
        .option("--description <text>")
        .option("--body <text>")
        .option("--title <text>")
        .option("--kind <kind>", "", "improvement")
        .option("--scope <scope>", "", "cli")
        .option("--command <argv>")
        .option("--error <msg>")
        .option("--severity <sev>")
        .option("--complexity <n>", "", Number)
        .option("--from-json <file>")
        .option("--dry-run")
        .action(guarded(async (description, opts, cmd) => {
        // Shared merge: only the flags the caller ACTUALLY typed outrank the
        // JSON object (--kind/--scope carry defaults, fb#299); unknown or
        // wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts, CREATE_FROM_JSON);
        // A filed report is a permanent record and is exactly the prose most
        // likely to quote an identifier in backticks (fb#552).
        warnIfShellMangled({ description: description ?? opts.description, body: opts.body });
        const client = await getClient();
        writeJson(await runFeedbackCreate(client, {
            description: resolveFeedbackCreateDescription({
                description,
                descriptionFlag: opts.description,
                bodyFlag: opts.body,
                title: opts.title,
            }),
            kind: opts.kind,
            scope: opts.scope,
            command: opts.command,
            error: opts.error,
            severity: opts.severity,
            complexity: opts.complexity,
            dryRun: opts.dryRun,
        }));
    }));
    f.command("list")
        .option("--status <status>")
        .option("--unresolved")
        .option("--all")
        .option("--full")
        .option("--kind <kind>")
        .option("--scope <scope>")
        .option("--search <text>")
        // Not a bare `Number` like its --max-complexity sibling: `none` is a real
        // value here (select the UNESTIMATED rows), and Number("none") is NaN, which
        // the backend's parseInt guard would drop as "no filter" — returning the whole
        // table as if nothing had been asked for (fb#535).
        .option("--complexity <n>", "", (v) => (v.toLowerCase() === "none" ? "none" : Number(v)))
        .option("--max-complexity <n>", "", Number)
        .option("--oldest")
        .option("--limit <n>", "", Number)
        .option("--offset <n>", "", Number)
        .option("--unclaimed")
        .option("--mine")
        .option("--claimed-by <label>", "", String)
        .action(jsonAction(getClient, (client, opts) => runFeedbackList(client, opts)));
    f.command("get <id>")
        // `show` — the reflex spelling for read-one-row; callers retried it twice
        // rather than reading the did-you-mean (feedback #373, earlier #275).
        .alias("show")
        .option("--full")
        .action(guarded(async (idStr) => {
        const id = parseRefId(idStr, "feedback", "get");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackGet(client, id)));
    }));
    // `[note]` is positional so this command AGREES with its sibling
    // `feedback create <description>` (fb#583). Both take one id-ish thing plus
    // one block of prose, and they used to disagree about where the prose goes —
    // which is what made `resolve <id> -- "text"` feel natural enough to get typed
    // twice in a row, for an exit 4 that never mentioned --note.
    f.command("resolve <id> [note]")
        .option("--status <status>")
        .option("--note <text>")
        .option("--reason <text>")
        .option("--resolution <text>")
        .option("--from-json <file>")
        .option("--dry-run")
        .option("--full")
        .action(guarded(async (idStr, notePositional, opts, cmd) => {
        const id = parseRefId(idStr, "feedback", "resolve");
        // Shared merge: only EXPLICITLY-typed flags outrank the JSON object
        // (feedback #327); unknown or wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts, RESOLVE_FROM_JSON);
        // Checked BEFORE the write: a resolution note is a permanent record, and
        // an eaten backtick would otherwise land in it with no diagnostic (fb#552).
        // The POSITIONAL is checked too — it is the form most exposed to the
        // shell, not least.
        warnIfShellMangled({
            note: notePositional ?? opts.note,
            resolution: opts.resolution,
            reason: opts.reason,
        });
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackResolve(client, id, {
            status: opts.status,
            // The positional and the three flag aliases merge AFTER the
            // per-key merge, so a note from JSON and a different one typed on
            // argv are both kept. mergeNoteFlags de-dupes, so passing the same
            // text positionally AND as --note stores it once.
            note: mergeNoteFlags(notePositional, opts.note, opts.resolution, opts.reason),
            dryRun: opts.dryRun,
            full: opts.full,
        })));
    }));
    f.command("update <id>")
        .option("--scope <scope>")
        .option("--kind <kind>")
        .option("--severity <sev>")
        .option("--complexity <n>", "", Number)
        .option("--description <text>")
        .option("--body <text>")
        .option("--append-description <text>")
        .option("--from-json <file>")
        .option("--dry-run")
        .option("--full")
        .action(guarded(async (idStr, opts, cmd) => {
        const id = parseRefId(idStr, "feedback", "update");
        // Shared merge: only EXPLICITLY-typed flags outrank the JSON object
        // (feedback #332); unknown or wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts, UPDATE_FROM_JSON);
        // --body (argv or JSON) is an alias for --description (feedback #278);
        // fold AFTER the merge so both sources are agreement-checked, mirroring
        // `changelog update` — differing values exit 4 instead of one silently
        // winning.
        const desc = foldAliases([opts.description, opts.body], "Provide the description via --description or --body, not both with different values");
        if (desc !== undefined)
            opts.description = desc;
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackUpdate(client, id, {
            scope: opts.scope,
            kind: opts.kind,
            severity: opts.severity,
            complexity: opts.complexity,
            description: opts.description,
            appendDescription: opts.appendDescription,
            dryRun: opts.dryRun,
            full: opts.full,
        })));
    }));
    f.command("claim <id>")
        .option("--by <label>", "The claiming agent/session label (defaults to $IB_CLAIM_ID, then user@host)")
        .option("--ttl-hours <n>", "Lease length in hours, 1-24 (default 24, measured from FIRST acquire)", Number)
        .option("--steal", "Take a row under another agent's LIVE claim")
        .option("--reason <text>", "Human-readable why-string stored in audit logs (X-Action-Reason)")
        .action(guarded(async (idStr, opts) => {
        const id = parseRefId(idStr, "feedback", "claim");
        const client = await getClient();
        writeJson(await runFeedbackClaim(client, id, opts));
    }));
    f.command("release [id]")
        .option("--by <label>", "The holder label — must match the label used to claim")
        .option("--all", "Release EVERY claim held by this label instead of one row")
        .option("--reason <text>", "Human-readable why-string stored in audit logs (X-Action-Reason)")
        .action(guarded(async (idStr, opts) => {
        const id = idStr === undefined ? null : parseRefId(idStr, "feedback", "release");
        const client = await getClient();
        writeJson(await runFeedbackRelease(client, id, opts));
    }));
    f.command("count")
        .option("--kind <kind>")
        .option("--scope <scope>")
        .action(jsonAction(getClient, (client, opts) => runFeedbackCount(client, opts)));
}
//# sourceMappingURL=index.js.map