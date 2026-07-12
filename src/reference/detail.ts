/**
 * `ib reference detail …` — the AI's on-demand business-context surface, now
 * DB-backed via /api/cli/command-catalog (was local `spec.detail`). The detail
 * tier no longer lives in betonicli source; it is read/written over the API so
 * the optimize-ib-summaries routine needs only an IB_TOKEN (no git).
 */
import type { ApiClient } from "../api/client.js";
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { type CallerTier, visibleSpecs, getCallerTier } from "../tier.js";
import { writeFlagsToHeaders, type WriteFlags } from "../api/writeFlags.js";
import type { AssessFlags } from "../assess.js";
import { lineDiff } from "../textDiff.js";
import { applyTextEdit, type TextEditOp } from "../textEdit.js";

function resolveCommand(commandParts: string[], tier: CallerTier): string {
  // Be liberal in what we accept. Every discovery surface — including this
  // command's sibling `reference detail list` — emits `command` WITH the leading
  // `ib` (e.g. "ib vehicle driver available"). An AI naturally copies that value
  // straight back into `get`/`set`, which would otherwise double the prefix
  // ("ib ib vehicle driver available" → exit 5). Strip any leading `ib` token(s) and
  // collapse whitespace so the list→get round-trip just works, whether the path
  // arrives as separate args or one quoted string.
  const path = commandParts.join(" ").trim().replace(/\s+/g, " ").replace(/^(?:ib\s+)+/i, "");
  const command = `ib ${path}`.trim();
  const visible = visibleSpecs(COMMAND_SPECS, tier).some((s) => s.command === command);
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
}

export async function runReferenceDetailList(
  client: ApiClient,
  stalest?: number,
  domain?: string,
  withDetail = false,
  needsReview = false,
  maxConfidence?: number,
  // Client-side discovery filters (fb#164) — applied AFTER the fetch so no
  // backend change is needed, mirroring `runReferenceDetailLint`. `search` keeps
  // rows whose command PATH contains the substring (the `LIKE` an exec-only
  // caller can't run); `orphans` keeps only rows whose command no longer exists
  // in the live spec catalogue (the discover half of the discover→delete flow).
  search?: string,
  orphans = false
): Promise<ReferenceDetailListResult> {
  const p = new URLSearchParams();
  if (stalest) p.set("stalest", String(stalest));
  if (domain) p.set("domain", domain);
  if (withDetail) p.set("withDetail", "1");
  if (needsReview) p.set("needsReview", "1");
  if (needsReview && maxConfidence != null) p.set("maxConfidence", String(maxConfidence));
  const q = p.toString();
  const res = await client.get<ReferenceDetailListResult>(`/api/cli/command-catalog${q ? `?${q}` : ""}`);
  if (!search && !orphans) return res;
  // Compare orphans against the FULL spec set (NOT tier-filtered) — a
  // developer-tier command still has a spec, so its row is not an orphan.
  const live = orphans ? new Set(COMMAND_SPECS.map((s) => s.command)) : null;
  const needle = search?.toLowerCase();
  const items = res.items.filter((row) => {
    if (live && live.has(row.command)) return false;
    if (needle && !row.command.toLowerCase().includes(needle)) return false;
    return true;
  });
  return { ...res, items, count: items.length };
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
  const { items } = await runReferenceDetailList(client);
  const live = new Set(COMMAND_SPECS.map((s) => s.command));
  const orphans: CatalogLintFinding[] = items
    .filter((row) => !live.has(row.command))
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
  const current = await runReferenceDetail(client, commandParts, tier);
  const before = String((current as Record<string, unknown>)[field] ?? "");
  const { next, matchCount } = applyTextEdit(before, op);
  if (flags.dryRun) {
    const diff = lineDiff(before, next);
    return {
      dryRun: true,
      command: current.command,
      field,
      ...(matchCount !== undefined ? { matchCount } : {}),
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      sameContent: diff.sameContent,
      unified: diff.unified,
    };
  }
  return runReferenceDetailSet(client, commandParts, { [field]: next }, flags, tier);
}
