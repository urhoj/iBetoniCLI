/**
 * `ib reference detail …` — the AI's on-demand business-context surface, now
 * DB-backed via /api/cli/command-catalog (was local `spec.detail`). The detail
 * tier no longer lives in betonicli source; it is read/written over the API so
 * the optimize-ib-summaries routine needs only an IB_TOKEN (no git).
 */
import type { ApiClient } from "../api/client.js";
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { type CallerTier, isHiddenAtTier, getCallerTier } from "../tier.js";
import { writeFlagsToHeaders, type WriteFlags } from "../api/writeFlags.js";
import type { AssessFlags } from "../assess.js";
import { applyTextEdit, textEditDryRunEnvelope, type TextEditOp } from "../textEdit.js";
import { qs } from "../api/query.js";
import { warnNote } from "../output/json.js";

function resolveCommand(commandParts: string[], tier: CallerTier): string {
  // Be liberal in what we accept. Every discovery surface — including this
  // command's sibling `reference detail list` — emits `command` WITH the leading
  // `ib` (e.g. "ib vehicle driver available"). An AI naturally copies that value
  // straight back into `get`/`set`, which would otherwise double the prefix
  // ("ib ib vehicle driver available" → exit 5). Strip any leading `ib` token(s) and
  // collapse whitespace so the list→get round-trip just works, whether the path
  // arrives as separate args or one quoted string.
  const command = normalizeCommandKey(commandParts);
  const visible = COMMAND_SPECS.some((s) => s.command === command && !isHiddenAtTier(s, tier));
  if (!visible) {
    throw new CliError(`unknown command: ${command}. Use \`ib commands\` for valid paths.`, 0, null, 5);
  }
  return command;
}

export async function runReferenceDetail(
  client: ApiClient,
  commandParts: string[],
  tier: CallerTier = getCallerTier()
): Promise<{ command: string; summary: string | null; detail: string; hint: string }> {
  const command = resolveCommand(commandParts, tier);
  return client.get(`/api/cli/command-catalog/${encodeURIComponent(command)}`);
}

export interface ReferenceDetailListResult {
  items: Array<{
    command: string;
    summary: string | null;
    lastReviewed: string | null;
    runs: number;
    aiConfidence?: number | null;
    needsHumanReview?: boolean | null;
    // Present only when `withDetail` is set AND the backend that serves it is
    // deployed; the per-row detail text otherwise lives behind `detail get`.
    detail?: string | null;
  }>;
  count: number;
  // Set only when `--limit` actually cut rows off the end. There is no cursor
  // here (the backend returns the whole catalog in one shot), so this flag is
  // the only signal that what you got is not the whole answer.
  truncated?: boolean;
}

/**
 * Filters for {@link runReferenceDetailList}. Keys mirror the Commander option
 * names of `ib reference detail list` — the eight-positional signature this
 * replaced made every call site a run of bare `undefined, false, undefined`
 * placeholders whose meaning could only be read off the declaration.
 *
 * `search` / `orphans` are CLIENT-SIDE filters (fb#164) applied after the fetch
 * so no backend change is needed, mirroring `runReferenceDetailLint`: `search`
 * keeps rows whose command PATH contains the substring (the `LIKE` an exec-only
 * caller can't run); `orphans` keeps only rows whose command no longer exists in
 * the live spec catalogue (the discover half of the discover→delete flow).
 *
 * `limit` is a client-side payload CAP, not a pager (there is no cursor to page
 * with). It exists because `--limit` is near-universal across the ib list
 * surface, so an AI reaches for it by pattern and lost a round-trip to exit 4
 * (fb#619). Distinct from `stalest`, which caps the SERVER page and orders it.
 */
export interface ReferenceDetailListOptions {
  stalest?: number;
  domain?: string;
  withDetail?: boolean;
  needsReview?: boolean;
  maxConfidence?: number;
  search?: string;
  orphans?: boolean;
  limit?: number;
}

export async function runReferenceDetailList(
  client: ApiClient,
  opts: ReferenceDetailListOptions = {}
): Promise<ReferenceDetailListResult> {
  const { stalest, domain, withDetail, needsReview, maxConfidence, search, orphans, limit } = opts;
  const res = await client.get<ReferenceDetailListResult>(
    `/api/cli/command-catalog${qs({
      stalest: stalest || undefined,
      domain: domain || undefined,
      // `1`, not the raw boolean — `qs` would serialise `true` as "true".
      withDetail: withDetail ? 1 : undefined,
      needsReview: needsReview ? 1 : undefined,
      maxConfidence: needsReview && maxConfidence != null ? maxConfidence : undefined,
    })}`
  );
  if (!search && !orphans && limit == null) return res;
  // Compare orphans against the FULL spec set (NOT tier-filtered) — a
  // developer-tier command still has a spec, so its row is not an orphan.
  const live = orphans ? new Set(COMMAND_SPECS.map((s) => s.command)) : null;
  const needle = search?.toLowerCase();
  const filtered = res.items.filter((row) => {
    if (live && live.has(row.command)) return false;
    if (needle && !row.command.toLowerCase().includes(needle)) return false;
    return true;
  });
  // Cap LAST, so `--limit` means "at most N of what I asked for" rather than
  // "N fetched rows, then narrowed to fewer" — the latter would silently return
  // less than N with the filters applied, which reads as an empty result.
  const items = limit == null ? filtered : filtered.slice(0, limit);
  return {
    ...res,
    items,
    count: items.length,
    ...(items.length < filtered.length ? { truncated: true } : {}),
  };
}

/**
 * Normalize a command path to the exact catalog key format (`ib <path>`) WITHOUT
 * the registry-visibility check `resolveCommand` enforces. `delete` targets
 * ORPHANED rows whose command no longer exists in the catalogue (a command
 * re-homed under a new domain leaves its old key behind), so it must accept an
 * arbitrary key. Strips any leading `ib` token(s) and collapses whitespace, so
 * `delete ib ai conversation`, `delete ai conversation`, and a single quoted
 * string all resolve to the same stored key. Empty path → exit 4.
 */
function normalizeCommandKey(commandParts: string[]): string {
  const tokens = commandParts.join(" ").trim().split(/\s+/).filter(Boolean);
  while (tokens[0]?.toLowerCase() === "ib") tokens.shift();
  if (tokens.length === 0) {
    throw new CliError("a command path is required (e.g. `ib reference detail delete ai conversation`)", 0, null, 4);
  }
  return `ib ${tokens.join(" ")}`;
}

export async function runReferenceDetailDelete(
  client: ApiClient,
  commandParts: string[],
  flags: WriteFlags = {}
): Promise<unknown> {
  // No resolveCommand() gate — the target is an orphan key, not a live command.
  const command = normalizeCommandKey(commandParts);
  return client.delete(`/api/cli/command-catalog/${encodeURIComponent(command)}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Server-enforced field caps (`MAX_SUMMARY` / `MAX_DETAIL` in puminet5api
 * `routes/cli/commandCatalogCliRoutes.js`). Mirrored here so an over-cap write
 * fails offline naming the submitted length instead of costing a round trip, and
 * so an `--append` that overflows surfaces in the `--dry-run` PREVIEW rather than
 * only on the real write (fb#284). Keep in sync if the server cap moves.
 */
const FIELD_MAX = { summary: 160, detail: 2000 } as const;

function assertWithinCap(field: DetailEditableField, text: string, verb = "is"): void {
  const max = FIELD_MAX[field];
  if (text.length > max) {
    throw new CliError(`${field} ${verb} ${text.length} chars, max ${max}`, 0, null, 4);
  }
}

export async function runReferenceDetailSet(
  client: ApiClient,
  commandParts: string[],
  body: { summary?: string; detail?: string } & AssessFlags,
  flags: WriteFlags = {},
  tier: CallerTier = getCallerTier()
): Promise<unknown> {
  // Same client-side visibility gate as the read: an unknown (or tier-hidden)
  // command exits 5 before any write leaves the process.
  const command = resolveCommand(commandParts, tier);
  if (body.summary !== undefined) assertWithinCap("summary", body.summary);
  if (body.detail !== undefined) assertWithinCap("detail", body.detail);
  const payload: Record<string, unknown> = {};
  if (body.summary !== undefined) payload.summary = body.summary;
  if (body.detail !== undefined) payload.detail = body.detail;
  if (body.aiConfidence !== undefined) payload.aiConfidence = body.aiConfidence;
  if (body.needsHumanReview) payload.needsHumanReview = true;
  return client.put(`/api/cli/command-catalog/${encodeURIComponent(command)}`, payload, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** One `reference detail lint` finding: a catalog row with no matching live command. */
export interface CatalogLintFinding {
  command: string;
  severity: "warn";
  kind: "orphan";
  summary: string | null;
  hint: string;
}

/**
 * Audit the DB command-catalog for ORPHAN rows — keys whose command no longer
 * exists in the live `COMMAND_SPECS`. The catalog is keyed by command string and
 * nothing prunes it, so every rename/re-home leaves its old row behind (the class
 * behind fb#73: `ib customer prh` → `ib opendata prh`). Those orphans surface in
 * `reference detail list` but `get`/`set` then reject them (exit 5), a confusing
 * round-trip; the remedy is `reference detail delete`. Read-only: one GET of the
 * whole catalog plus a local set-diff. Compares against the FULL spec set (NOT
 * tier-filtered) — a developer-tier command still has a spec, so its row is not an
 * orphan. Each finding carries the ready-to-run prune command.
 */
export async function runReferenceDetailLint(
  client: ApiClient
): Promise<{ items: CatalogLintFinding[]; count: number }> {
  const { items } = await runReferenceDetailList(client, { orphans: true });
  const orphans: CatalogLintFinding[] = items
    .map((row) => ({
      command: row.command,
      severity: "warn",
      kind: "orphan",
      summary: row.summary ?? null,
      hint: `orphan: no live command — prune with \`ib reference detail delete ${row.command.replace(/^ib /, "")} --reason <r>\` (or seed the re-homed command)`,
    }));
  return { items: orphans, count: orphans.length };
}

/** Catalog text fields editable in-field. */
export const DETAIL_EDITABLE_FIELDS = ["summary", "detail"] as const;
export type DetailEditableField = (typeof DETAIL_EDITABLE_FIELDS)[number];

/**
 * Edit mode for `reference detail set`: in-field partial edit of summary or
 * detail. Reads the current catalog entry (resolves + validates the command),
 * applies the edit, then `--dry-run` returns the field diff without writing, or
 * a real run delegates to `runReferenceDetailSet` (PATCH — only the edited field).
 */
export async function runReferenceDetailEdit(
  client: ApiClient,
  commandParts: string[],
  field: DetailEditableField,
  op: TextEditOp,
  flags: WriteFlags = {},
  tier: CallerTier = getCallerTier()
): Promise<unknown> {
  const command = resolveCommand(commandParts, tier);
  // resolveCommand above already proved the command itself is valid/visible, so
  // a 404 here means the catalog just has no row yet — not a wrong command path
  // (fb#784, previously surfaced the generic not-found/tenancy hint). Edit
  // against an empty field instead: append/prepend then behave like a create,
  // matching the glossary `--append-definition` spirit; --replace still fails
  // its own "0 matches" check below, which is the correct outcome for it.
  let before = "";
  let resolvedCommand = command;
  try {
    const current = await runReferenceDetail(client, commandParts, tier);
    before = String((current as Record<string, unknown>)[field] ?? "");
    resolvedCommand = current.command;
  } catch (e) {
    if (!(e instanceof CliError && e.statusCode === 404)) throw e;
  }
  const { next, matchCount, seamInserted } = applyTextEdit(before, op);
  // Cap-check the MERGED text before the dry-run branch, so a preview that would
  // 400 on write reports it here instead of returning a clean-looking diff.
  assertWithinCap(field, next, "would be");
  if (seamInserted) warnNote("[ib] a newline seam was inserted between the existing text and the new text (fb#790)");
  if (flags.dryRun) {
    return textEditDryRunEnvelope(before, next, matchCount, { command: resolvedCommand }, field, seamInserted);
  }
  return runReferenceDetailSet(client, commandParts, { [field]: next }, flags, tier);
}
