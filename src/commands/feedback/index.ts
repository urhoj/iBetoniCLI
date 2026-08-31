/**
 * `ib feedback` — file and triage CLI improvement proposals / trouble reports.
 *
 * When an AI (or CI) hits friction using `ib`, it files a freetext note here so
 * the CLI can be improved. Submission is QUIET (no GitHub issue, no email, no spam
 * to you or the user — distinct from `bugReport`); developers who opted in get a
 * push notification. A developer-gated analyzer skill reads them back via
 * `ib dev feedback list` and closes the loop.
 *
 * `create` is sent as a META request → exempt from the read-only write-lock, so
 * an agent running `--read-only` can still report friction. `list`/`get`/`resolve`
 * are developer-only; `resolve` is a real write (blocked under read-only).
 * `--dry-run` (create + resolve) resolves CLIENT-SIDE: prints the payload, no send.
 */
import os from "node:os";
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, toListEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  FEEDBACK_LIST_CAP,
  FEEDBACK_LIST_DEFAULT,
  warnIfLimitCapped,
} from "../../api/listCaps.js";
import { failWith, warnNote, writeJson } from "../../output/json.js";
import { assertEnum, assertEnumCsv, parseRefId, intFlag, cappedInt } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { foldAliases, warnIfShellMangled } from "../_shared/flags.js";
import { applyFromJson, type FromJsonConfig } from "../_shared/fromJson.js";
import { qs } from "../../api/query.js";
import { readJsonInput } from "../../api/parseBody.js";
import { getEmbeddedCtx } from "../../embedded.js";
import { CliError, errorMessage } from "../../api/errors.js";
import { writeFlagsToHeaders } from "../../api/writeFlags.js";
import { resolveDate } from "../../dates.js";

// Exported for specs.ts: the spec flags declare these as machine-readable
// `allowed:` sets (validation envelopes), single-sourced from here.
export const KINDS = ["improvement", "bug", "idea", "legal"] as const;
type Kind = (typeof KINDS)[number];
export const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "impeccable", "other"] as const;
type Scope = (typeof SCOPES)[number];
export const STATUSES = ["open", "reviewed", "applied", "dismissed"] as const;
/**
 * The statuses a row can still be WORKED in — the default list bucket, and the
 * only rows for which "part of this shipped without closing it" is a true
 * statement (fb#647). A closed row cannot be claimed, so it needs no warning.
 */
export const ACTIVE_STATUSES = ["open", "reviewed"] as const;
export const SEVERITIES = ["critical", "major", "minor", "cosmetic"] as const;
type Severity = (typeof SEVERITIES)[number];

/**
 * The `--severity` FILTER value that selects the rows carrying no grade at all.
 * Spelled the same as `--complexity none` deliberately: the two triage grades
 * are asked about together, and a caller who learned one spelling must not have
 * to discover a second (fb#535 established the idiom).
 */
export const SEVERITY_NONE = "none";

/**
 * What `--severity` accepts as a FILTER: every grade, plus the `none` sentinel.
 *
 * Deliberately NOT the same list as SEVERITIES, which is what `create`/`update`
 * accept as a settable grade — `none` selects rows that hold no grade, it is not
 * a value a row can ever hold. Keeping them separate is what stops `--severity
 * none` from becoming writable on those commands.
 *
 * It exists because the check used to run against SEVERITIES with a bypass
 * branch around `none`, so a typo was told the valid values were "critical,
 * major, minor, cosmetic" — omitting one the CLI actually accepts, and
 * contradicting the machine-readable `allowed` set in the spec.
 */
export const SEVERITY_FILTERS = [...SEVERITIES, SEVERITY_NONE] as const;

/**
 * The five gate kinds a feedback row can be waiting on — must stay identical
 * to `GATE_KINDS` in puminet5api's `modules/feedback/feedbackSql.js` (fb#446).
 * Nothing enforces that across the repo boundary; keep the two lists in sync
 * by hand when either changes.
 */
export const GATE_KINDS = ["deploy", "soak", "legal", "owner", "backlog"] as const;
type GateKind = (typeof GATE_KINDS)[number];

/**
 * The subset the backend auto-closes via `POST /api/feedback/gates/clear` —
 * the only values `gate-clear --kind` accepts. The other three kinds
 * (`soak`/`owner`/`backlog`) close only by a human calling `resolve`; the
 * backend's `clearGates` primitive enforces the same restriction server-side,
 * so this is a client-side pre-check, not the only guard.
 */
export const AUTO_CLOSE_GATE_KINDS = ["deploy", "legal"] as const;

/**
 * Case-folding coercion shared by EVERY `--severity` flag in this group.
 *
 * One flag name should behave one way: `list --severity Major` folded case
 * while `create`/`update --severity Major` exited 4 — same flag, same domain,
 * opposite answer depending on which leaf you were on.
 *
 * Folded at the parser rather than inside `assertEnum` so the blast radius stays
 * this group. And folded at ALL rather than left to the enum check, because
 * `closestName` is case-sensitive and SEVERITY_SYNONYMS is keyed on lowercase
 * words — an unfolded `MAJOR` would miss both and get a bare enum dump instead
 * of a did-you-mean, which is the worse answer for an AI caller.
 */
const foldSeverityCase = (v: string): string => v.toLowerCase();

/**
 * The OTHER severity vocabulary — high/medium/low is what issue trackers and
 * most AI tooling use, so it is the natural first guess here and too far from
 * ours for edit distance to bridge (`high`→`major` is 5 edits). Mapped to a
 * `did you mean` hint on the exit-4 message, NOT accepted as an alias: this
 * command's whole contract is that an unknown enum value is reported, never
 * quietly rewritten (feedback #369).
 */
const SEVERITY_SYNONYMS: Record<string, string> = {
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
function validateComplexity(value: unknown, flag = "--complexity"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < COMPLEXITY_MIN || n > COMPLEXITY_MAX) {
    failWith(`${flag} must be an integer ${COMPLEXITY_MIN}-${COMPLEXITY_MAX}`, 4);
  }
  return n;
}

/** `YYYY-MM-DD` or a full ISO datetime — mirrors `ib log`'s local assertIsoDate. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Validate `--gate-until` CLIENT-SIDE (fb#446): the backend does not validate
 * it at all — a malformed date reaches SQL and surfaces as a 500 + a Sentry
 * event where a 400 was meant, and the CLI is the real caller. `today` /
 * `yesterday` / `tomorrow` expand via the shared `resolveDate`; an
 * explicitly-passed EMPTY string is the documented "clear this field"
 * convention (see `clearHint`) and passes through unchecked — there is
 * nothing to validate about clearing a field.
 */
function assertGateUntil(value: string | undefined): string | undefined {
  if (!value) return value;
  const resolved = resolveDate(value) ?? value;
  if (!ISO_DATE_RE.test(resolved) || Number.isNaN(Date.parse(resolved))) {
    failWith(`--gate-until must be YYYY-MM-DD or an ISO datetime (got '${value}').`, 4);
  }
  return resolved;
}

const MAX_FREETEXT = 200;
/** Head/tail split for a truncated field (fb#714): appended updates land at the
 *  TAIL (`--append-description`), so a head-only cut discarded exactly the
 *  newest content in a queue designed to be appended to. */
const TRUNCATE_HEAD = 120;
const TRUNCATE_TAIL = 80;
const ELISION = " … ";
/**
 * The server's row cap. Was a local literal duplicating the backend constant,
 * and was applied ONLY on the multi-status merge path below — the single-status
 * path (which `--all` takes) never set `truncated` at all, so `--limit 1000`
 * answered 200 rows of 604 and looked complete (fb#605). Now one shared mirror.
 */
const CAP = FEEDBACK_LIST_CAP;
const TRUNCATED_FIELDS = ["description", "resolution", "errorText"] as const;
const TRUNCATE_HINT =
  "description/resolution/errorText over 200 chars show head+tail (middle elided) so an appended update is never cut off; ib dev feedback get <id> for full text";

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
const COMPLEXITY_NULL_HINT =
  "a complexity filter is active and EXCLUDES rows with no estimate (complexity is optional on create, so most rows are unset — absent means unestimated, not complex); re-run without --complexity/--max-complexity to see the full candidate set, or with --complexity none to see ONLY the unestimated rows";

/**
 * Emitted when `--severity` was sent but the rows that came back do not obey it.
 *
 * The filter is deploy-gated, and an older backend does not reject an unknown
 * query param — it IGNORES it and answers with the unfiltered list. That failure
 * is silent and points the wrong way: `--severity none` against such a backend
 * returns every active row, which reads as "the entire queue is ungraded" and
 * would send a groomer to re-grade rows that are already graded — the precise
 * thing the skill's fill-NULLs-only rule exists to prevent. So we do not merely
 * DOCUMENT the gate (which is what `--complexity none` had to settle for); we
 * check the answer against what was asked and say so when they disagree.
 */
const SEVERITY_IGNORED_HINT =
  "⚠ --severity was IGNORED by this backend (rows came back that do not match it) — " +
  "the filter is deploy-gated and predates the backend serving --endpoint. These results are " +
  "UNFILTERED by severity; do not read them as the graded/ungraded set. Filter client-side, " +
  "or point --endpoint at a backend that has it.";

/**
 * True when a severity filter was requested but the result violates it — i.e.
 * the backend ignored the param. `none` asks for rows with NO severity, so any
 * row carrying one is a violation; a named severity is violated by any row not
 * carrying exactly it. An empty result proves nothing either way and is not a
 * violation: a genuinely empty slice looks identical to a filtered-out one.
 */
function severityFilterIgnored(
  severity: string | undefined,
  rows: Record<string, unknown>[]
): boolean {
  if (!severity || !rows.length) return false;
  const matches = (r: Record<string, unknown>) =>
    severity === SEVERITY_NONE ? r.severity == null : r.severity === severity;
  return rows.some((r) => !matches(r));
}

/**
 * The `--held` twin of {@link SEVERITY_IGNORED_HINT} (fb#886). An older backend
 * ignores the unknown query param and answers unfiltered — and for THIS filter
 * the silent failure points exactly the wrong way: the full active list under a
 * `--held` lens reads as "every row is being worked on right now", the opposite
 * of the triage answer the flag exists to give.
 */
const HELD_IGNORED_HINT =
  "⚠ --held was IGNORED by this backend (rows came back that no live lease holds) — " +
  "the filter is deploy-gated and predates the backend serving --endpoint. These results are " +
  "UNFILTERED by claim state; do NOT read them as \"everything is claimed\". Filter client-side " +
  "on claimState, or point --endpoint at a backend that has it.";

/**
 * True when `--held` was requested but a returned row has no live lease — i.e.
 * the backend ignored the param. Judged by the same clock-evaluated predicate
 * `claimState` is derived from, so an expired lease counts as a violation too.
 * An empty result proves nothing either way and is not a violation.
 */
function heldFilterIgnored(
  held: boolean | undefined,
  rows: Record<string, unknown>[],
  me: string
): boolean {
  if (!held || !rows.length) return false;
  return rows.some((r) => deriveClaimState(r, me) === "free");
}

/** Cap a string at MAX_FREETEXT chars, keeping HEAD+TAIL (elided middle) so an
 * appended update at the tail is never the part that gets cut (fb#714).
 * Non-strings pass through untouched. */
function truncateField(v: unknown): { value: unknown; cut: boolean } {
  if (typeof v === "string" && v.length > MAX_FREETEXT) {
    const head = v.slice(0, TRUNCATE_HEAD);
    const tail = v.slice(-TRUNCATE_TAIL);
    return { value: head + ELISION + tail, cut: true };
  }
  return { value: v, cut: false };
}

/** Shallow-copy a feedback row with its long free-text fields capped. */
function compactRow(
  row: Record<string, unknown>
): { row: Record<string, unknown>; cut: boolean } {
  const out = { ...row };
  let cut = false;
  for (const f of TRUNCATED_FIELDS) {
    if (f in out) {
      const t = truncateField(out[f]);
      out[f] = t.value;
      if (t.cut) cut = true;
    }
  }
  return { row: out, cut };
}

/**
 * The server-side filter set: exactly what rides on the query string. A new
 * list flag belongs here IF (and only if) the backend filters on it — adding
 * `--held` required editing three separately-spelled copies of this bag, and
 * missing one would have been a silent no-op (simplify-review of fb#886).
 */
interface FeedbackFilterParams {
  status?: string;
  kind?: string;
  scope?: string;
  search?: string;
  severity?: string;
  complexity?: number | string;
  maxComplexity?: number;
  limit?: number;
  offset?: number;
  oldest?: boolean;
  unclaimed?: boolean;
  claimedBy?: string;
  held?: boolean;
}

/** Everything `list` accepts: the server filters plus client-side shaping. */
export interface FeedbackListOptions extends FeedbackFilterParams {
  unresolved?: boolean;
  all?: boolean;
  full?: boolean;
  mine?: boolean;
  /** `--gated [kind]` — `true` for the bare flag, a kind string to narrow. */
  gated?: boolean | string;
}

/** Build the query string and GET a page of feedback rows (always an array). */
async function fetchRows(
  client: ApiClient,
  params: FeedbackFilterParams
): Promise<Record<string, unknown>[]> {
  const suffix = qs({
    status: params.status || undefined,
    kind: params.kind || undefined,
    scope: params.scope || undefined,
    search: params.search || undefined,
    severity: params.severity || undefined,
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
    held: params.held ? "1" : undefined,
  });
  const rows = await client.get<Record<string, unknown>[]>(`/api/feedback${suffix}`);
  return Array.isArray(rows) ? rows : [];
}

export interface FeedbackCreateInput {
  description: string;
  kind?: string;
  scope?: string;
  command?: string;
  error?: string;
  severity?: string;
  complexity?: number;
  /** What this row is waiting for; deploy|soak|legal|owner|backlog (see GATE_KINDS). */
  gateKind?: string;
  /** Gate pointer: deploy repo@sha · legal TYPE@version · owner free text. */
  gateRef?: string;
  /** Wake date (ISO) for --gate-kind soak|backlog. */
  gateUntil?: string;
  dryRun?: boolean;
}

/**
 * Resolve the create description from the positional or its --description /
 * --body aliases (--body is the gh/git convention an agent reaches for by
 * default, and already this CLI's free-text body flag on `message chat send` —
 * feedback #278). `--title` folds in as the description's first line (there is
 * no stored title column — gh-issue-style `--title X --description Y` habit,
 * feedback #240/#241).
 */
export function resolveFeedbackCreateDescription(input: {
  description?: string;
  descriptionFlag?: string;
  bodyFlag?: string;
  title?: string;
}): string {
  const description = foldAliases(
    [input.description, input.descriptionFlag, input.bodyFlag],
    "Provide the description once — positionally, with --description, or with --body; if several are given, they must match"
  );
  const title = input.title?.trim();
  if (!description) {
    if (title) return title;
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
const CREATE_FROM_JSON: FromJsonConfig = {
  nonPayload: new Set(["fromJson", "dryRun", "help"]),
  readShapeAliases: { errorText: "error" },
  numericFields: new Set(["complexity"]),
};

interface FeedbackCreateBody {
  kind: Kind;
  scope: Scope;
  description: string;
  command?: string;
  error?: string;
  severity?: Severity;
  complexity?: number;
  gateKind?: GateKind;
  gateRef?: string;
  gateUntil?: string;
  context?: { conversationId: number };
}

function buildCreateBody(input: FeedbackCreateInput): FeedbackCreateBody {
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
  if (input.gateKind) assertEnum(input.gateKind, GATE_KINDS, "--gate-kind");
  const body: FeedbackCreateBody = {
    kind: (input.kind as Kind) ?? "improvement",
    scope: (input.scope as Scope) ?? "cli",
    description,
  };
  if (input.command) body.command = input.command;
  if (input.error) body.error = input.error;
  if (input.severity) body.severity = input.severity as Severity;
  if (input.complexity !== undefined) body.complexity = validateComplexity(input.complexity);
  if (input.gateKind) body.gateKind = input.gateKind as GateKind;
  if (input.gateRef) body.gateRef = input.gateRef;
  if (input.gateUntil !== undefined) body.gateUntil = assertGateUntil(input.gateUntil);
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
/**
 * The group's client-side --dry-run echo — create/resolve/update all emit this
 * exact shape (documented contract), so it is pinned in one place.
 */
const wouldSend = (
  method: string,
  path: string,
  body: unknown
): Record<string, unknown> => ({ dryRun: true, wouldSend: { method, path, body } });

export async function runFeedbackCreate(
  client: ApiClient,
  input: FeedbackCreateInput
): Promise<Record<string, unknown>> {
  const body = buildCreateBody(input);
  if (input.dryRun) {
    return wouldSend("POST", "/api/feedback", body);
  }
  return client.post<Record<string, unknown>>("/api/feedback", body, { meta: true });
}

/** Bounded parallelism, mirroring `ib glossary import`'s IMPORT_CONCURRENCY. */
const FEEDBACK_IMPORT_CONCURRENCY = 5;

/**
 * File SEVERAL reports from one JSON array file (fb#1056).
 *
 * `create` takes exactly one object, on purpose — it is the shape a caller
 * templates off a `feedback get` row, and rejecting an array there produces a
 * clearer message than silently guessing. But the multi-row case is not exotic:
 * it is what the routines do. `post-impl-verify` files one row per confirmed
 * finding, and `analyze-cli-feedback`, `groom-memory` and `review-legal-docs`
 * all have the same fan-out shape, so the alternative is N invocations or a
 * caller-side splitting step.
 *
 * Partial failure is REPORTED, never rolled back, exactly as glossary import
 * does it: one malformed entry must not cost the caller the rows that were
 * fine, and there is no transaction to roll back into. Each result carries its
 * array `index` so a caller can line failures up with the file it sent.
 */
export async function runFeedbackImport(
  client: ApiClient,
  entries: Array<Record<string, unknown>>,
  flags: { dryRun?: boolean } = {}
): Promise<{
  results: Array<{ index: number; feedbackId: number | null; ok: boolean; error?: string }>;
  ok: number;
  failed: number;
}> {
  const results = new Array<{ index: number; feedbackId: number | null; ok: boolean; error?: string }>(
    entries.length
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FEEDBACK_IMPORT_CONCURRENCY, entries.length) }, async () => {
      while (next < entries.length) {
        const i = next++;
        const e = entries[i];
        if (!e || typeof e !== "object" || Array.isArray(e)) {
          results[i] = { index: i, feedbackId: null, ok: false, error: "entry is not a JSON object" };
          continue;
        }
        try {
          const description = resolveFeedbackCreateDescription({
            description: e.description as string | undefined,
            bodyFlag: e.body as string | undefined,
            title: e.title as string | undefined,
          });
          const created = await runFeedbackCreate(client, {
            description,
            kind: (e.kind as string) ?? "improvement",
            scope: (e.scope as string) ?? "cli",
            command: e.command as string | undefined,
            error: e.error as string | undefined,
            severity: e.severity as string | undefined,
            complexity: e.complexity === undefined ? undefined : Number(e.complexity),
            dryRun: flags.dryRun,
          });
          const id = created?.feedbackId;
          results[i] = { index: i, feedbackId: typeof id === "number" ? id : null, ok: true };
        } catch (err) {
          results[i] = { index: i, feedbackId: null, ok: false, error: errorMessage(err) };
        }
      }
    })
  );
  return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/**
 * Resolve the requested status filter into a list of statuses, or null for no
 * filter (every status). With NO selector the DEFAULT is the active bucket
 * (`open` + `reviewed`) — closed items (`applied`/`dismissed`) are hidden unless
 * you ask for them. `--all` = null (every status); `--unresolved` = open +
 * reviewed; `--status` = a single value or comma-separated list. The three
 * selectors are mutually exclusive; conflicting/unknown values exit 4.
 */
function resolveStatuses(opts: {
  status?: string;
  unresolved?: boolean;
  all?: boolean;
}): string[] | null {
  const selectors = [
    opts.all && "--all",
    opts.unresolved && "--unresolved",
    opts.status && "--status",
  ].filter(Boolean);
  if (selectors.length > 1) {
    failWith(`Use only one of ${selectors.join(", ")}`, 4);
  }
  if (opts.all) return null;
  if (opts.status) {
    const list = opts.status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    assertEnumCsv(list, STATUSES, "--status");
    if (list.length) return list;
  }
  // Default (and --unresolved): the active bucket. Closed items need --all/--status.
  return [...ACTIVE_STATUSES];
}

/**
 * Classify one row's lease against the caller.
 *
 * An EXPIRED claim is "free", not "held" — the lease invariant is evaluated
 * against the clock at read time, never against a stored flag. Rendering a
 * lapsed lease as "held" would hide exactly the rows the 24h reclamation frees.
 */
export function deriveClaimState(
  row: { claimedBy?: unknown; claimExpiresAt?: unknown },
  me: string
): "free" | "held" | "mine" {
  const by = row.claimedBy;
  const until = row.claimExpiresAt;
  if (typeof by !== "string" || !by) return "free";
  // A malformed/unparseable claimExpiresAt must degrade toward FREE, not HELD:
  // `new Date(garbage).getTime()` is NaN, and `NaN <= Date.now()` is false, so
  // an unguarded comparison would fall through to "held"/"mine" — the opposite
  // of this feature's whole premise, that a lease can never get permanently
  // stuck. Corrupt data is exactly the case the clock-based check exists for.
  const t = new Date(String(until)).getTime();
  if (!until || Number.isNaN(t) || t <= Date.now()) return "free";
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
 * Claim filters (`--unclaimed` / `--mine` / `--claimed-by` / `--held`) are
 * mutually exclusive — each answers a different question ("what can I pick up"
 * vs "what do I hold" vs "what does labelX hold" vs "what is anyone working on
 * right now") and combining them has no coherent meaning. Every returned row
 * also carries a derived `claimState` (see `deriveClaimState`) regardless of
 * which filter (if any) was used.
 */
export async function runFeedbackList(
  client: ApiClient,
  opts: FeedbackListOptions
): Promise<ListEnvelope<Record<string, unknown>>> {
  assertEnum(opts.kind, KINDS, "--kind");
  assertEnum(opts.scope, SCOPES, "--scope");
  // SEVERITY_FILTERS, not SEVERITIES: `none` is a legal filter value, so it has
  // to be IN the allowed list rather than bypassed around the check — bypassing
  // left it out of the rejection message. `high`/`medium`/`low` are the
  // vocabulary most issue trackers use and are too far from ours for edit
  // distance to bridge, so SEVERITY_SYNONYMS carries them to a did-you-mean
  // rather than a bare enum dump.
  assertEnum(opts.severity, SEVERITY_FILTERS, "--severity", SEVERITY_SYNONYMS);
  // --gated [kind]: Commander sets `true` for the bare flag, a kind string for
  // `--gated deploy`. Validated the same way as the other enum filters, but
  // applied CLIENT-SIDE below (see the branch further down) — unlike
  // --severity/--held, the backend has no server-side gate filter to wait on
  // (the gate columns are new, fb#446), and `SELECT *` already returns
  // gateKind/gateRef/gateUntil on every row, so there is nothing to gain from
  // a query-string param the backend would only ignore.
  const gatedKind = typeof opts.gated === "string" ? opts.gated : undefined;
  if (gatedKind) assertEnum(gatedKind, GATE_KINDS, "--gated");
  const claimFilters = [opts.unclaimed, opts.mine, opts.claimedBy, opts.held].filter(Boolean);
  if (claimFilters.length > 1) {
    failWith("Use only one of --unclaimed / --mine / --claimed-by / --held", 4);
  }
  const { by: me, source: idSource } = resolveClaim(undefined);
  const claimedBy = opts.mine ? me : opts.claimedBy;
  const statuses = resolveStatuses(opts);
  let items: Record<string, unknown>[];
  let truncated = false;

  warnIfLimitCapped(opts.limit, CAP, "ib dev feedback list");

  // The filters both branches send identically. Hoisted because they were
  // written out twice and differ only in status/limit/offset — a NEW filter
  // threaded into one copy and not the other would work under an explicit
  // `--status` and silently no-op on the default active-bucket path, which is
  // the path almost every caller takes. `fetchRows` fixes the query-string key
  // order internally, so spreading here cannot change the emitted URL.
  const filters = {
    kind: opts.kind,
    scope: opts.scope,
    search: opts.search,
    severity: opts.severity,
    complexity: opts.complexity,
    maxComplexity: opts.maxComplexity,
    oldest: opts.oldest,
    unclaimed: opts.unclaimed,
    claimedBy,
    held: opts.held,
  };

  // --gated forces the multi-page merge path below even for a single status:
  // the filter runs CLIENT-SIDE (see above), and slicing by the caller's
  // limit/offset BEFORE that filter — the single-request branch's whole
  // approach — would silently drop gated rows sitting past position `limit`
  // in the raw, unfiltered page.
  if (!opts.gated && (!statuses || statuses.length <= 1)) {
    items = await fetchRows(client, {
      ...filters,
      status: statuses?.[0],
      limit: opts.limit,
      offset: opts.offset,
    });
    // The path the merge branch below already covered, and this one did not:
    // a FULL page means more rows exist. The effective limit is min(requested,
    // CAP) — checking against the RAW request is what missed the case, since
    // asking for 1000 and receiving 200 fails `items.length >= 1000` (fb#605).
    const effective = Math.min(opts.limit ?? FEEDBACK_LIST_DEFAULT, CAP);
    if (client.getLastListMeta?.()?.truncated || items.length >= effective) truncated = true;
  } else {
    // null (the --all case) has no per-status query to fan out over — one
    // request with no status filter, same as the single-request branch above.
    const statusList: (string | undefined)[] = statuses ?? [undefined];
    const pages = await Promise.all(
      statusList.map((s) => fetchRows(client, { ...filters, status: s, limit: CAP }))
    );
    if (pages.some((p) => p.length >= CAP)) truncated = true;
    // feedbackId is monotonic with createdAt, so it doubles as the merge key.
    // dir = +1 oldest-first (ASC), -1 newest-first (DESC, the default).
    const dir = opts.oldest ? 1 : -1;
    let merged = pages
      .flat()
      .sort((a, b) => dir * (Number(a.feedbackId) - Number(b.feedbackId)));
    if (opts.gated) {
      merged = merged.filter((r) => r.gateKind != null && (!gatedKind || r.gateKind === gatedKind));
    }
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    if (merged.length > offset + limit) truncated = true;
    items = merged.slice(offset, offset + limit);
  }

  const severityIgnored = severityFilterIgnored(opts.severity, items);
  const heldIgnored = heldFilterIgnored(opts.held, items, me);

  items = items.map((r) => ({ ...r, claimState: deriveClaimState(r, me) }));

  // A DERIVED `me` (user@host fallback — see resolveClaim) is a machine-wide
  // label shared by every unset-env session on the host: it is not proof this
  // caller made the claim, just that some unset-env session did. Reporting
  // "mine" there actively misreports ownership (fb#901) — downgrade to "held"
  // and warn once, rather than silently mislabeling another session's claim.
  if (idSource === "derived" && items.some((r) => r.claimState === "mine")) {
    items = items.map((r) => (r.claimState === "mine" ? { ...r, claimState: "held" as const } : r));
    warnNote(`[ib] ⚠ claimState "mine" downgraded to "held" — ${derivedIdentityNote(me)}`);
  }

  let cut = false;
  if (!opts.full) {
    items = items.map((r) => {
      const c = compactRow(r);
      if (c.cut) cut = true;
      return c.row;
    });
  }
  warnPartlyShipped(items);

  const env = listEnvelope(items);
  if (truncated) env.truncated = true;
  const hints: string[] = [];
  if (cut) hints.push(TRUNCATE_HINT);
  if (opts.complexity !== undefined || opts.maxComplexity !== undefined)
    hints.push(COMPLEXITY_NULL_HINT);
  if (severityIgnored) {
    warnNote(SEVERITY_IGNORED_HINT);
    hints.push(SEVERITY_IGNORED_HINT);
  }
  if (heldIgnored) {
    warnNote(HELD_IGNORED_HINT);
    hints.push(HELD_IGNORED_HINT);
  }
  if (hints.length) env.hint = hints.join("; ");
  return env;
}

/**
 * GET /api/feedback/:id — developer-only single row. Includes the same derived
 * `claimState` (free|held|mine, fb#901 "mine"->"held" downgrade included) that
 * `list` already computes — `get` used to omit it, forcing callers to re-derive
 * claim liveness themselves (fb#973).
 */
export async function runFeedbackGet(
  client: ApiClient,
  id: number
): Promise<Record<string, unknown>> {
  const row = await client.get<Record<string, unknown>>(`/api/feedback/${id}`);
  const { by: me, source: idSource } = resolveClaim(undefined);
  let claimState = deriveClaimState(row, me);
  if (idSource === "derived" && claimState === "mine") {
    claimState = "held";
    warnNote(`[ib] ⚠ claimState "mine" downgraded to "held" — ${derivedIdentityNote(me)}`);
  }
  return { ...row, claimState };
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
export async function runFeedbackCount(
  client: ApiClient,
  opts: { kind?: string; scope?: string }
): Promise<Record<string, unknown>> {
  // Same silent-empty trap as `list` — here it reads as a total of 0 (fb#369).
  assertEnum(opts.kind, KINDS, "--kind");
  assertEnum(opts.scope, SCOPES, "--scope");
  const suffix = qs({ kind: opts.kind || undefined, scope: opts.scope || undefined });
  try {
    return await client.get<Record<string, unknown>>(`/api/feedback/stats${suffix}`);
  } catch (e) {
    const status = e instanceof CliError ? e.statusCode : 0;
    if (status === 401 || status === 403) throw e;
    return countClientSide(client, opts);
  }
}

/** One incomplete-row finding from `ib dev feedback lint`. */
export interface FeedbackLintFinding {
  feedbackId: number;
  issue: "ungraded" | "stale-claim" | "closed-no-resolution" | "applied-no-changelog";
  detail: string;
  severity: "warn" | "info";
}

/**
 * `ib dev feedback lint` — GET /api/feedback/lint → the rows that are
 * INCOMPLETE, as opposed to merely open. Sibling of `ib glossary lint`.
 *
 * Thin on purpose: the whole value is that the audit runs SERVER-side, over the
 * whole table. The CLI's own route to this answer is a page capped at 200 rows
 * whose drops are the OLDEST — the longest-neglected, i.e. exactly the rows a
 * completeness audit exists to surface (fb#536, fb#605).
 */
export async function runFeedbackLint(
  client: ApiClient
): Promise<ListEnvelope<FeedbackLintFinding>> {
  // toListEnvelope, not listEnvelope + a hand-rolled Array.isArray guard: it is
  // the house helper for exactly this (a non-array body — null, an error object —
  // yields an empty envelope rather than throwing).
  return toListEnvelope<FeedbackLintFinding>(await client.get("/api/feedback/lint"));
}

/** Pre-fb#536 rollup: bucket one capped page in JS. Only reached on an older backend. */
async function countClientSide(
  client: ApiClient,
  opts: { kind?: string; scope?: string }
): Promise<Record<string, unknown>> {
  const rows = await fetchRows(client, { kind: opts.kind, scope: opts.scope, limit: CAP });
  const byStatus: Record<string, number> = { open: 0, reviewed: 0, applied: 0, dismissed: 0 };
  const byKind: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  let unestimated = 0;
  for (const r of rows) {
    const s = String(r.status ?? "");
    if (s in byStatus) byStatus[s] += 1;
    const k = String(r.kind ?? "unknown");
    byKind[k] = (byKind[k] ?? 0) + 1;
    const sc = String(r.scope ?? "unknown");
    byScope[sc] = (byScope[sc] ?? 0) + 1;
    if (r.complexity == null) unestimated += 1;
  }
  const out: Record<string, unknown> = { total: rows.length, byStatus, byKind, byScope, unestimated };
  if (rows.length >= CAP) {
    out.truncated = true;
    out.hint =
      "count is a lower bound — this backend has no /api/feedback/stats, so the rollup ran client-side and hit the 200-row cap. The rows dropped are the OLDEST, so `open` is understated most.";
  }
  return out;
}

/**
 * The changelog entries linked to a feedback row, as a junction-aware backend
 * attaches them (`changelogLinks: [{changelogId, role}]`, the same shape on
 * `list`, `get` and `claim`).
 *
 * An older backend omits the key entirely, which reads as `[]` here — correct,
 * because the only safe reading of "this backend cannot tell me" is to say
 * nothing rather than assert that nothing shipped.
 */
function readChangelogLinks(row: Record<string, unknown>): { changelogId: number; role: string }[] {
  const raw = row.changelogLinks;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({ changelogId: Number(l.changelogId), role: String(l.role ?? "") }))
    .filter((l) => Number.isFinite(l.changelogId));
}

/**
 * Say so when the row you just claimed already carries changelog links (fb#647).
 *
 * This is the moment the wasted work would otherwise start. A partial fix is
 * recordable — `ib dev changelog add --feedback <id> --no-resolve` links the
 * shipped half WITHOUT closing the row — but nothing ever SAID so at claim time,
 * so an agent picked a row whose CLI half had already shipped and spent a full
 * investigation cycle rediscovering it. The links have always been in the claim
 * response; they were simply never surfaced.
 *
 * stderr, never stdout: the JSON data contract is untouched.
 */
function warnAlreadyLinked(row: Record<string, unknown>): void {
  const links = readChangelogLinks(row);
  if (!links.length) return;
  const id = row.feedbackId ?? "?";
  const rendered = links.map((l) => `cl#${l.changelogId} (${l.role})`).join(", ");
  warnNote(
    `[ib] note: fb#${id} already carries ${links.length} changelog link${links.length > 1 ? "s" : ""} — ${rendered}. ` +
      `Part of this item may already have shipped; read the entry before investigating: ib dev changelog get ${links[0].changelogId}`
  );
}

/** How many linked rows a list note names before it summarises the rest. */
const LINKED_ROWS_NAMED = 5;

/**
 * Make partly-shipped rows legible at BROWSE time (fb#647).
 *
 * `--unclaimed` is where an agent picks its next item, and a row carrying a
 * `references` link — work recorded but deliberately not closed — used to look
 * identical to an untouched one. Claiming it and only then discovering the
 * shipped half is the expensive order to find out in; one stderr line at list
 * time is the cheap one.
 *
 * Deploy-gated the safe way: an older backend sends no links, so the note simply
 * does not fire. It never claims a row is untouched.
 *
 * Only ACTIVE rows count. Every closed row has a `resolves` link by
 * construction, so counting those made the note fire on all three rows of a
 * `--status applied` page while asserting they had shipped "without closing the
 * row" — the opposite of true, on the browse this feature does not even serve.
 */
function warnPartlyShipped(items: Record<string, unknown>[]): void {
  const active = items.filter((r) => ACTIVE_STATUSES.includes(r.status as never));
  const linked = active.filter((r) => readChangelogLinks(r).length > 0);
  if (!linked.length) return;
  const named = linked
    .slice(0, LINKED_ROWS_NAMED)
    .map((r) => `fb#${r.feedbackId} → ${readChangelogLinks(r).map((l) => `cl#${l.changelogId}`).join("+")}`)
    .join(", ");
  const rest = linked.length - Math.min(linked.length, LINKED_ROWS_NAMED);
  warnNote(
    `[ib] note: ${linked.length} of ${active.length} un-closed rows already carry changelog links (${named}${rest > 0 ? `, +${rest} more` : ""}) — ` +
      `part of that work has shipped without closing the row. Read the entry (ib dev changelog get <id>) before claiming one.`
  );
}

/**
 * PUT /api/feedback/:id responses may carry an advisory `warning` when the
 * write just landed on a row another agent currently holds under a LIVE
 * claim lease (the lease never blocks a write, only warns — feedback #585).
 * Printed to stderr exactly once per call regardless of `--full`: it is a
 * safety signal, not a verbosity detail, so it must reach the caller even in
 * compact mode. Never stdout — the JSON data contract stays untouched.
 */
function warnClaimAdvisory(row: Record<string, unknown>): void {
  if (typeof row.warning === "string" && row.warning) {
    warnNote(`[ib] ⚠ ${row.warning}`);
  }
}

/**
 * Shared PUT + advisory-warn step behind both `resolve` and `update`: send the
 * body with the caller's claim identity riding on `x-claim-id` (so the backend
 * can tell a writer's own claim apart from someone else's), then surface any
 * lease warning the response carries. Callers still do their own
 * post-processing (compact ack shape, status hint, …).
 */
async function putWithClaimAdvisory(
  client: ApiClient,
  id: number,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const row = await client.put<Record<string, unknown>>(`/api/feedback/${id}`, body, {
    headers: { "x-claim-id": resolveClaimId(undefined) },
  });
  warnClaimAdvisory(row);
  return row;
}

/**
 * Shared shape for the write-ack projectors below: copy a whitelist of keys
 * verbatim, copy one capped free-text field, then carry `warning` (the
 * claim-lease advisory — see {@link warnClaimAdvisory}) through even in
 * compact mode, since it's a safety signal, not verbosity.
 */
function buildAck(
  row: Record<string, unknown>,
  keys: string[],
  cappedField: string
): Record<string, unknown> {
  const ack: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in row) ack[k] = row[k];
  }
  if (cappedField in row) ack[cappedField] = truncateField(row[cappedField]).value;
  if ("warning" in row) ack.warning = row.warning;
  return ack;
}

/** Project a resolved row to the compact write-ack fields (resolution capped). */
function compactAck(row: Record<string, unknown>): Record<string, unknown> {
  return buildAck(row, ["feedbackId", "status", "updatedAt"], "resolution");
}

export interface FeedbackResolveInput {
  status?: string;
  note?: string;
  dryRun?: boolean;
  full?: boolean;
}

/**
 * `resolve`'s `--from-json` config (feedback #327) — the shared pipeline with
 * no Commander defaults, so the precedence collapses to explicit flag > JSON.
 * The three note aliases (--note/--reason/--resolution) are merged AFTER the
 * per-key merge via {@link mergeNoteFlags}, so a note supplied in JSON and a
 * different one typed on argv are both kept, exactly as for three argv flags.
 * Unknown/wrong-typed JSON keys exit 4 (shared contract, fb#298 class).
 */
const RESOLVE_FROM_JSON: FromJsonConfig = {
  nonPayload: new Set(["fromJson", "dryRun", "full", "help"]),
};

/**
 * --note / --reason / --resolution are aliases for the same stored note. When a
 * caller passes more than one with DIFFERENT values — natural for an AI, since
 * --reason means the X-Action-Reason audit header on every other write command —
 * keep them all (joined), instead of silently dropping all but one (feedback #216).
 */
export function mergeNoteFlags(...values: Array<string | undefined>): string | undefined {
  const distinct = [...new Set(values.filter((v): v is string => v !== undefined))];
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
export async function runFeedbackResolve(
  client: ApiClient,
  id: number,
  input: FeedbackResolveInput
): Promise<Record<string, unknown>> {
  assertEnum(input.status, STATUSES, "--status");
  if (input.status === undefined && input.note === undefined) {
    failWith("Provide --status and/or --note", 4);
  }
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body.status = input.status;
  if (input.note !== undefined) body.resolution = input.note;
  if (input.dryRun) {
    return wouldSend("PUT", `/api/feedback/${id}`, body);
  }
  const row = await putWithClaimAdvisory(client, id, body);
  const out = input.full ? { ...row } : compactAck(row);
  if (input.status === undefined && (row.status === "open" || row.status === "reviewed")) {
    out.hint = `status unchanged (${row.status}) - pass --status applied|dismissed to close`;
  }
  return out;
}

/** Project an updated row to the compact edit-ack fields (description capped). */
function compactUpdateAck(row: Record<string, unknown>): Record<string, unknown> {
  return buildAck(
    row,
    ["feedbackId", "scope", "kind", "severity", "complexity", "gateKind", "gateRef", "gateUntil", "updatedAt"],
    "description"
  );
}

export interface FeedbackUpdateInput {
  scope?: string;
  kind?: string;
  severity?: string;
  complexity?: number;
  description?: string;
  /** Text appended to the CURRENT description (read-merge-write) — never replaces it. */
  appendDescription?: string;
  /**
   * Audit why-string (fb#801) — `update` has no separate note field to carry it
   * on, so it merges into --append-description the same way `resolve` merges
   * --reason into its note (mergeNoteFlags dedupes an identical value). Rejected
   * alongside a full --description replace, where merging would be ambiguous.
   */
  reason?: string;
  /** What this row is waiting for; deploy|soak|legal|owner|backlog. `""` clears it. */
  gateKind?: string;
  /** Gate pointer: deploy repo@sha · legal TYPE@version · owner free text. `""` clears it. */
  gateRef?: string;
  /** Wake date (ISO) for --gate-kind soak|backlog. `""` clears it. */
  gateUntil?: string;
  dryRun?: boolean;
  full?: boolean;
}

/**
 * `update`'s `--from-json` config (feedback #332) — the shared pipeline with no
 * Commander defaults, so the precedence collapses to explicit flag > JSON.
 * `body` (JSON or argv) folds into `description` AFTER the merge via
 * {@link foldAliases}, mirroring `changelog update` — differing values across
 * the two spellings exit 4 instead of one silently winning. Unknown/wrong-typed
 * JSON keys exit 4 (shared contract, fb#298 class).
 */
const UPDATE_FROM_JSON: FromJsonConfig = {
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
export async function runFeedbackUpdate(
  client: ApiClient,
  id: number,
  input: FeedbackUpdateInput
): Promise<Record<string, unknown>> {
  assertEnum(input.scope, SCOPES, "--scope");
  assertEnum(input.kind, KINDS, "--kind");
  assertEnum(input.severity, SEVERITIES, "--severity", SEVERITY_SYNONYMS);
  // Empty string is the documented CLEAR convention (clearHint) — only a
  // non-empty value is validated against the enum, mirroring assertGateUntil.
  if (input.gateKind) assertEnum(input.gateKind, GATE_KINDS, "--gate-kind");
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
  // --reason has no field of its own to land on (fb#801) — it can only merge
  // into the append, not a full replace, where blending in reason text would
  // silently change what --description was asked to set.
  if (input.reason !== undefined && input.description !== undefined) {
    failWith("--reason cannot be combined with --description (a full replace) — use --append-description instead", 4);
  }
  const appendDescription = mergeNoteFlags(input.appendDescription?.trim(), input.reason?.trim());
  const body: Record<string, unknown> = {};
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.kind !== undefined) body.kind = input.kind;
  if (input.severity !== undefined) body.severity = input.severity;
  if (input.complexity !== undefined) body.complexity = validateComplexity(input.complexity);
  if (input.description !== undefined) body.description = input.description.trim();
  if (input.gateKind !== undefined) body.gateKind = input.gateKind;
  if (input.gateRef !== undefined) body.gateRef = input.gateRef;
  if (input.gateUntil !== undefined) body.gateUntil = assertGateUntil(input.gateUntil);
  // Read-merge-write: --description REPLACES the filed report, which is the
  // destructive half of feedback #332. Appending keeps the original text and
  // adds to it, so later commentary can never overwrite the evidence.
  if (appendDescription !== undefined) {
    const current = await runFeedbackGet(client, id);
    const existing = typeof current.description === "string" ? current.description : "";
    body.description = existing ? `${existing.trimEnd()}\n\n${appendDescription}` : appendDescription;
  }
  if (Object.keys(body).length === 0) {
    failWith(
      "Provide at least one of --scope / --kind / --severity / --complexity / --description / --append-description / --reason / --gate-kind / --gate-ref / --gate-until",
      4
    );
  }
  if (input.dryRun) {
    return wouldSend("PUT", `/api/feedback/${id}`, body);
  }
  const row = await putWithClaimAdvisory(client, id, body);
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
 *
 * WHICH rung answered is reported alongside the label, because `"derived"` —
 * nothing identified the caller, so `user@host` was INVENTED for it — is
 * invisible at the call site and is what fb#652/fb#695 both turn on: an agent
 * claims and releases from DIFFERENT shell invocations (each tool call is a
 * fresh shell, so an exported env var does not survive), so the claim goes in
 * under `IB_CLAIM_ID` and the release asks as `juhau@iBetoni2`.
 *
 * ONE ladder, walked once (fb#716). This was previously spelled out three times
 * — here, in `claimIdSource`, and in `assertClaimIdentity` — in three subtly
 * different dialects, and two of them disagreed: a `??` chain treats `""` as a
 * present value and short-circuits on it, while a `?.trim()` chain skips past
 * it. So `--by=""` with `IB_CLAIM_ID` set resolved to `user@host` while
 * REPORTING `env`, which silenced the fb#695 warning in exactly one of the
 * cases it exists for. A blank rung now falls THROUGH to the next one, which is
 * what this doc block always claimed happened.
 */
function resolveClaim(explicit?: string): { by: string; source: ClaimIdSource } {
  const ladder: [ClaimIdSource, string | null | undefined][] = [
    ["flag", explicit],
    ["ctx", getEmbeddedCtx()?.claimId],
    ["env", process.env.IB_CLAIM_ID],
  ];
  for (const [source, v] of ladder) {
    if (v?.trim()) return { by: v.trim().slice(0, CLAIM_LABEL_MAX), source };
  }
  let user = "unknown";
  try {
    user = os.userInfo().username;
  } catch {
    // os.userInfo() throws on some locked-down containers; the host half is
    // still a useful discriminator, so degrade rather than fail the command.
  }
  return { by: `${user}@${os.hostname()}`.slice(0, CLAIM_LABEL_MAX), source: "derived" };
}

/** Which rung of the ladder supplied the label; `derived` = invented, not chosen. */
export type ClaimIdSource = "flag" | "ctx" | "env" | "derived";

/** The claiming agent's label. See {@link resolveClaim}. */
export function resolveClaimId(explicit?: string): string {
  return resolveClaim(explicit).by;
}

/** Where that label came from. See {@link resolveClaim}. */
export function claimIdSource(explicit?: string): ClaimIdSource {
  return resolveClaim(explicit).source;
}

/**
 * The sentence both release paths append when the identity was DERIVED. Names
 * `IB_CLAIM_ID` first and `--by` as the override, because the workspace
 * CLAUDE.md mandates the env var: `resolve`/`update` have no `--by` flag at all
 * and prove holdership from `IB_CLAIM_ID`, so an agent that identifies itself
 * only via `--by` mismatches on the `x-claim-id` header later and gets warned
 * about its own claim (fb#652 — the old remedy sent the reader to `--by`, the
 * one lever the documented workflow tells them not to use).
 */
function derivedIdentityNote(by: string): string {
  return (
    `the label "${by}" was DERIVED from user@host, not chosen — nothing set $IB_CLAIM_ID, --by, or an MCP session id. ` +
    `If you claimed under a different label, set IB_CLAIM_ID to it and retry (--by <label> overrides for a one-off call).`
  );
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
function assertClaimIdentity(explicit: string | undefined, action: string): void {
  // Via the shared ladder (fb#716) rather than a fourth hand-rolled truthiness
  // test. The old `explicit || ctx || env` accepted a WHITESPACE label, which
  // then resolved to `user@host` anyway — so `--by " "` walked through this
  // guard and claimed under the container-wide label, i.e. precisely the
  // lease-that-does-not-lock it exists to refuse. `claimIdSource` trims.
  if (claimIdSource(explicit) !== "derived") return;
  if (process.env.IB_CLAIM_ID_SHARED !== "1") return;
  failWith(
    `cannot ${action}: this backend could not derive a per-caller identity, so the claim would be keyed on a label SHARED by every hosted caller — it would not actually lock the row. ` +
      `Pass --by <label> (a stable id for THIS agent, e.g. an agent/session name), or set IB_CLAIM_ID before invoking.`,
    4
  );
}

export async function runFeedbackClaim(
  client: ApiClient,
  id: number,
  input: { by?: string; ttlHours?: number; steal?: boolean; reason?: string }
): Promise<Record<string, unknown>> {
  assertClaimIdentity(input.by, "claim");
  const body: Record<string, unknown> = { by: resolveClaimId(input.by) };
  if (input.ttlHours !== undefined) body.ttlHours = input.ttlHours;
  if (input.steal) body.steal = true;
  const row = await client.post<Record<string, unknown>>(`/api/feedback/${id}/claim`, body, {
    headers: writeFlagsToHeaders({ reason: input.reason }),
  });
  warnAlreadyLinked(row);
  return row;
}

/** Release one lease (DELETE) or every lease held by the label (--all). */
export async function runFeedbackRelease(
  client: ApiClient,
  id: number | null,
  input: { by?: string; all?: boolean; reason?: string }
): Promise<Record<string, unknown>> {
  // --all only: a shared label would release every hosted caller's claims, not
  // just this one's. Releasing a SINGLE named id is safe either way.
  if (input.all) assertClaimIdentity(input.by, "release --all");
  const { by, source } = resolveClaim(input.by);
  const derived = source === "derived";
  const headers = writeFlagsToHeaders({ reason: input.reason });
  if (input.all) {
    const row = await client.post<Record<string, unknown>>(
      "/api/feedback/claims/release",
      { by },
      { headers }
    );
    // fb#695. `release --all` is the LAST call an agent makes, which is exactly
    // when a session-scoped IB_CLAIM_ID is most likely to have been lost. The
    // response is success-shaped and exits 0, and `released: 0` reads as "you
    // held nothing" rather than "you asked as somebody else" — so the rows sit
    // claimed for the full 24h expiry while every other agent's
    // `list --unclaimed` skips them, and the holder believes they released.
    //
    // WARN, not refuse: a genuine zero-release cleanup (CI, a session that
    // claimed nothing) is legitimate and must keep working. The fail-closed
    // rule in `assertClaimIdentity` covers the DIFFERENT case it was written
    // for — a label the backend cannot tell callers apart by.
    if (derived && Number(row.released ?? 0) === 0) {
      warnNote(`[ib] ⚠ release --all freed 0 claims — ${derivedIdentityNote(by)}`);
    }
    return row;
  }
  if (id == null) failWith("Provide a feedbackId, or --all to release every claim", 4);
  // ⚠ `ApiClient.delete` is `(path, opts?: FetchOptions)` and FetchOptions has NO
  // `body` field — passing `{ by }` as the second argument would be read as fetch
  // options and the label would never reach the backend, which would then 400.
  // The label therefore rides in the query string; the controller reads
  // `req.body?.by ?? req.query?.by`.
  const path = `/api/feedback/${id}/claim?by=${encodeURIComponent(by)}`;
  try {
    return await client.delete<Record<string, unknown>>(path, { headers });
  } catch (e) {
    // fb#652. The backend's 409 names the label it judged against ("Feedback 572
    // is not claimed by juhau@iBetoni2") — which reads as a real identity, so
    // the caller re-checks the id rather than the label. Say plainly that the
    // label was invented; that is the whole diagnosis in the common
    // claimed-in-one-shell-released-in-another case.
    if (derived && e instanceof CliError && e.statusCode === 409) {
      warnNote(`[ib] ⚠ ${derivedIdentityNote(by)}`);
    }
    throw e;
  }
}

export interface FeedbackGateClearInput {
  kind?: string;
  refPrefix?: string;
  clearedRef?: string;
  dryRun?: boolean;
}

/**
 * POST /api/feedback/gates/clear — close every row whose gate this event
 * cleared (developer-only). Called by `npm run swap` (deploy gates); the
 * LEGAL gate is cleared server-side inside `activateDocument`'s own
 * transaction and never comes through here. A REAL write — blocked under
 * --read-only. `--dry-run` resolves client-side (prints the payload, never
 * sends) — the route has no server-side `X-Dry-Run` guard.
 *
 * Deliberately narrow, mirroring the backend primitive: a scope (`refPrefix`)
 * and an evidence string (`clearedRef`), never a row id — this cannot be used
 * to close an arbitrary row.
 */
export async function runFeedbackGateClear(
  client: ApiClient,
  input: FeedbackGateClearInput
): Promise<Record<string, unknown>> {
  if (!input.kind) failWith("--kind is required (deploy | legal)", 4);
  assertEnum(input.kind, AUTO_CLOSE_GATE_KINDS, "--kind");
  if (!input.refPrefix || !input.clearedRef) {
    failWith("--ref-prefix and --cleared-ref are both required", 4);
  }
  const body = { gateKind: input.kind, refPrefix: input.refPrefix, clearedRef: input.clearedRef };
  if (input.dryRun) {
    return wouldSend("POST", "/api/feedback/gates/clear", body);
  }
  return client.post<Record<string, unknown>>("/api/feedback/gates/clear", body);
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
 *   gate-clear POST /api/feedback/gates/clear (developer-only; auto-close deploy/legal gates)
 */
export function registerFeedbackCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
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
    .option(
      "--title <text>"
    )
    .option("--kind <kind>", "", "improvement")
    .option(
      "--scope <scope>",
      "",
      "cli"
    )
    .option("--command <argv>")
    .option("--error <msg>")
    .option("--severity <sev>", "", foldSeverityCase)
    .option(
      "--complexity <n>",
      "",
      Number
    )
    .option("--gate-kind <kind>", "What this row is waiting for: deploy|soak|legal|owner|backlog. Empty (--gate-kind=) clears it")
    .option("--gate-ref <ref>", "Gate pointer: deploy repo@sha · legal TYPE@version (the version being superseded) · owner free text")
    .option("--gate-until <date>", "Wake date (ISO) for --gate-kind soak|backlog")
    .option(
      "--from-json <file>"
    )
    .option("--dry-run")
    .action(
      guarded(async (
        description: string | undefined,
        opts: {
          description?: string;
          body?: string;
          title?: string;
          kind?: string;
          scope?: string;
          command?: string;
          error?: string;
          severity?: string;
          complexity?: number;
          gateKind?: string;
          gateRef?: string;
          gateUntil?: string;
          fromJson?: string;
          dryRun?: boolean;
        },
        cmd: Command
      ) => {
        // Shared merge: only the flags the caller ACTUALLY typed outrank the
        // JSON object (--kind/--scope carry defaults, fb#299); unknown or
        // wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts as Record<string, unknown>, CREATE_FROM_JSON);
        // A filed report is a permanent record and is exactly the prose most
        // likely to quote an identifier in backticks (fb#552).
        warnIfShellMangled({ description: description ?? opts.description, body: opts.body });
        const client = await getClient();
        writeJson(
          await runFeedbackCreate(client, {
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
            gateKind: opts.gateKind,
            gateRef: opts.gateRef,
            gateUntil: opts.gateUntil,
            dryRun: opts.dryRun,
          })
        );
      })
    );

  f.command("import")
    .description("File SEVERAL reports from one JSON array file — the routines' fan-out shape (fb#1056)")
    .argument("<file>", "JSON array of create objects {description|body|title, kind?, scope?, command?, error?, severity?, complexity?} (or - for stdin)")
    .option("--dry-run")
    .action(
      guarded(async (file: string, opts: { dryRun?: boolean }) => {
        let arr: unknown;
        try {
          arr = readJsonInput(file);
        } catch {
          failWith("import: file is not valid JSON", 4);
        }
        // Mirrors create's own root-shape message, in the other direction: there
        // the array is wrong and an object is wanted, here the reverse. Both name
        // the sibling that takes the shape the caller actually has.
        if (!Array.isArray(arr)) {
          failWith("import: JSON root must be an array — a single entry goes to `ib dev feedback create --from-json`", 4);
        }
        writeJson(
          await runFeedbackImport(await getClient(), arr as Array<Record<string, unknown>>, opts)
        );
      })
    );

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
    .option("--complexity <n>", "", (v: string) => (v.toLowerCase() === "none" ? "none" : Number(v)))
    .option("--max-complexity <n>", "", intFlag("--max-complexity", 1))
    // See foldSeverityCase: one case policy across list/create/update.
    .option("--severity <s>", "", foldSeverityCase)
    .option("--oldest")
    .option("--limit <n>", "", cappedInt(200))
    .option("--offset <n>", "", intFlag("--offset", 0))
    .option("--unclaimed")
    .option("--mine")
    .option("--claimed-by <label>", "", String)
    .option("--held")
    .option("--gated [kind]", "Only rows carrying a gate; optionally restrict to one kind")
    .action(
      jsonAction(getClient, (client, opts: FeedbackListOptions) => runFeedbackList(client, opts))
    );

  // Mirrors `ib glossary lint`: read-only audit, `--strict` exits 1 on any
  // warn-level finding so CI / a scheduled runner can gate on it. Only the
  // issues a run can actually drive to zero are `warn` — see the backend's
  // getFeedbackLint for why the documentation-gap issues stay `info`.
  f.command("lint")
    .option("--strict")
    .action(
      guarded(async (opts: { strict?: boolean }) => {
        const res = await runFeedbackLint(await getClient());
        writeJson(res);
        if (opts.strict && res.items.some((f2) => f2.severity === "warn")) process.exitCode = 1;
      })
    );

  f.command("get <id>")
    // `show` — the reflex spelling for read-one-row; callers retried it twice
    // rather than reading the did-you-mean (feedback #373, earlier #275).
    .alias("show")
    .option("--full")
    .action(
      guarded(async (idStr: string) => {
        const id = parseRefId(idStr, "feedback", "get");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackGet(client, id)));
      })
    );

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
    .option(
      "--from-json <file>"
    )
    .option("--dry-run")
    .option("--full")
    .action(
      guarded(async (
        idStr: string,
        notePositional: string | undefined,
        opts: { status?: string; note?: string; reason?: string; resolution?: string; fromJson?: string; dryRun?: boolean; full?: boolean },
        cmd: Command
      ) => {
        const id = parseRefId(idStr, "feedback", "resolve");
        // Shared merge: only EXPLICITLY-typed flags outrank the JSON object
        // (feedback #327); unknown or wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts as Record<string, unknown>, RESOLVE_FROM_JSON);
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
        writeJson(
          await runWithSiblingHint(client, id, "changelog", () =>
            runFeedbackResolve(client, id, {
              status: opts.status,
              // The positional and the three flag aliases merge AFTER the
              // per-key merge, so a note from JSON and a different one typed on
              // argv are both kept. mergeNoteFlags de-dupes, so passing the same
              // text positionally AND as --note stores it once.
              note: mergeNoteFlags(notePositional, opts.note, opts.resolution, opts.reason),
              dryRun: opts.dryRun,
              full: opts.full,
            })
          )
        );
      })
    );

  f.command("update <id>")
    .option("--scope <scope>")
    .option("--kind <kind>")
    .option("--severity <sev>", "", foldSeverityCase)
    .option("--complexity <n>", "", intFlag("--complexity", 1))
    .option("--description <text>")
    .option("--gate-kind <kind>", "What this row is waiting for: deploy|soak|legal|owner|backlog. Empty (--gate-kind=) clears it")
    .option("--gate-ref <ref>", "Gate pointer: deploy repo@sha · legal TYPE@version (the version being superseded) · owner free text")
    .option("--gate-until <date>", "Wake date (ISO) for --gate-kind soak|backlog")
    .option("--body <text>")
    .option("--append-description <text>")
    .option("--reason <text>", "Audit why-string (fb#801) — merges into --append-description; rejected alongside a full --description replace")
    .option(
      "--from-json <file>"
    )
    .option("--dry-run")
    .option("--full")
    .action(
      guarded(async (
        idStr: string,
        opts: {
          scope?: string;
          kind?: string;
          severity?: string;
          complexity?: number;
          description?: string;
          body?: string;
          appendDescription?: string;
          reason?: string;
          gateKind?: string;
          gateRef?: string;
          gateUntil?: string;
          fromJson?: string;
          dryRun?: boolean;
          full?: boolean;
        },
        cmd: Command
      ) => {
        const id = parseRefId(idStr, "feedback", "update");
        // Shared merge: only EXPLICITLY-typed flags outrank the JSON object
        // (feedback #332); unknown or wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts as Record<string, unknown>, UPDATE_FROM_JSON);
        // --body (argv or JSON) is an alias for --description (feedback #278);
        // fold AFTER the merge so both sources are agreement-checked, mirroring
        // `changelog update` — differing values exit 4 instead of one silently
        // winning.
        const desc = foldAliases(
          [opts.description, opts.body],
          "Provide the description via --description or --body, not both with different values"
        );
        if (desc !== undefined) opts.description = desc;
        warnIfShellMangled({
          description: opts.description,
          appendDescription: opts.appendDescription,
          reason: opts.reason,
        });
        const client = await getClient();
        writeJson(
          await runWithSiblingHint(client, id, "changelog", () =>
            runFeedbackUpdate(client, id, {
              scope: opts.scope,
              kind: opts.kind,
              severity: opts.severity,
              complexity: opts.complexity,
              description: opts.description,
              appendDescription: opts.appendDescription,
              reason: opts.reason,
              gateKind: opts.gateKind,
              gateRef: opts.gateRef,
              gateUntil: opts.gateUntil,
              dryRun: opts.dryRun,
              full: opts.full,
            })
          )
        );
      })
    );

  f.command("claim <id>")
    .option("--by <label>", "The claiming agent/session label (defaults to $IB_CLAIM_ID, then user@host)")
    .option("--ttl-hours <n>", "Lease length in hours, 1-24 (default 24, measured from FIRST acquire)", intFlag("--ttl-hours", 1))
    .option("--steal", "Take a row under another agent's LIVE claim")
    .option("--reason <text>", "Human-readable why-string stored in audit logs (X-Action-Reason)")
    .action(
      guarded(async (idStr: string, opts: { by?: string; ttlHours?: number; steal?: boolean; reason?: string }) => {
        const id = parseRefId(idStr, "feedback", "claim");
        const client = await getClient();
        writeJson(await runFeedbackClaim(client, id, opts));
      })
    );

  f.command("release [id]")
    .option("--by <label>", "The holder label — must match the label used to claim")
    .option("--all", "Release EVERY claim held by this label instead of one row")
    .option("--reason <text>", "Human-readable why-string stored in audit logs (X-Action-Reason)")
    .action(
      guarded(async (idStr: string | undefined, opts: { by?: string; all?: boolean; reason?: string }) => {
        const id = idStr === undefined ? null : parseRefId(idStr, "feedback", "release");
        const client = await getClient();
        writeJson(await runFeedbackRelease(client, id, opts));
      })
    );

  f.command("count")
    // `stats` — hidden alias: the backend route this wraps is GET
    // /api/feedback/stats (modules/feedback/feedback.js `stats()`), so anyone
    // who read the route table or the module reaches for `feedback stats` and
    // dead-ended on exit 4. Worse than a plain miss: the envelope pointed at
    // `ib stats`, a top-level DELIVERY-statistics domain, routing the caller
    // away from the answer rather than to it (fb#611).
    .alias("stats")
    .option("--kind <kind>")
    .option("--scope <scope>")
    .action(
      jsonAction(getClient, (client, opts: { kind?: string; scope?: string }) =>
        runFeedbackCount(client, opts)
      )
    );

  // POST /api/feedback/gates/clear — called by `npm run swap`, not typed by
  // hand (see runFeedbackGateClear's doc). --kind is narrower than the full
  // GATE_KINDS on purpose: only deploy/legal auto-close.
  f.command("gate-clear")
    .option("--kind <kind>", "deploy | legal")
    .option("--ref-prefix <prefix>", "Scope, e.g. puminet5api@ or BETONIJERRY_TOS@")
    .option("--cleared-ref <ref>", "The evidence, e.g. puminet5api@1.30.5")
    .option("--dry-run")
    .action(
      jsonAction(
        getClient,
        (client, opts: { kind?: string; refPrefix?: string; clearedRef?: string; dryRun?: boolean }) =>
          runFeedbackGateClear(client, opts)
      )
    );
}
