/**
 * `ib bug` — file, read, and triage bug reports over the betoni.online
 * bugReport system (/api/bugs/*). Sibling of `ib feedback`: feedback is a quiet
 * CLI/AI friction sink; `ib bug` is the user-facing tracked-issue system with a
 * GitHub-issue + admin-email workflow and a developer triage tier.
 *
 * Every endpoint is already deployed — this group needs NO backend change and
 * no deploy gate. CLI-originated reports are auto-tagged via
 * browserInfo = ib-cli/<version> (the User-Agent the client already sends).
 *
 * Writes (create / comment / admin*) are REAL writes — blocked under
 * --read-only (exit 3), NOT meta-exempt like feedback. --dry-run is CLIENT-side
 * on every write (the /api/bugs/* routes have no server-side X-Dry-Run guard):
 * it prints the would-send payload and never sends. --reason → X-Action-Reason.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders } from "../../api/writeFlags.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { parseId } from "../../targets.js";

// ─── enums (mirror puminet4 bugReportConstants + commonLists) ────────────────
const BUG_TYPES = [
  "ui-display-issue",
  "functionality-error",
  "performance-problem",
  "data-incorrect",
  "other",
] as const;
const SEVERITIES = ["critical", "major", "minor", "cosmetic"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const STATUSES = ["new", "in-progress", "resolved", "closed"] as const;
const ORDER_BY = ["createdAt", "updatedAt", "severity", "status", "bugType", "bugReportId"] as const;
const ORDER_DIR = ["asc", "desc"] as const;

/** Throw exit-4 when a provided value is not in the allowed set. undefined passes. */
function assertEnum(value: string | undefined, allowed: readonly string[], flag: string): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new CliError(`--${flag} must be one of: ${allowed.join(", ")}`, 400, null, 4);
  }
}

/** Backend bug routes wrap reads in the betoni { success, data } envelope. */
function unwrapData(res: unknown): unknown {
  if (res && typeof res === "object" && "data" in res) {
    return (res as { data: unknown }).data;
  }
  return res;
}

/**
 * Whole days elapsed between an ISO timestamp and `now` (floored, never
 * negative). Returns null when the value is missing or unparseable, so callers
 * surface "unknown" rather than a misleading 0.
 */
function daysSince(iso: unknown, now: number): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * Enrich a bug-report row with two derived triage signals, computed client-side
 * (no backend change): `ageDays` (since createdAt) and `staleDays` (since the
 * last activity — updatedAt, falling back to createdAt). A high staleDays on an
 * open report is the "nobody has touched this in months" flag — the signal that
 * a months-old report can otherwise hide behind a raw ISO `createdAt`.
 */
function withAge(row: Record<string, unknown>, now: number): Record<string, unknown> {
  return {
    ...row,
    ageDays: daysSince(row.createdAt, now),
    staleDays: daysSince(row.updatedAt ?? row.createdAt, now),
  };
}

export interface BugCreateInput {
  type?: string;
  severity?: string;
  description?: string;
  steps?: string;
  priority?: string;
  reason?: string;
  dryRun?: boolean;
}

/**
 * POST /api/bugs/report — file a bug report. A REAL write (blocked under
 * --read-only) that ALSO opens a GitHub issue + emails admins. --dry-run
 * resolves client-side (no server dry-run guard on /report).
 */
export async function runBugCreate(
  client: ApiClient,
  input: BugCreateInput
): Promise<Record<string, unknown>> {
  const description = input.description?.trim();
  if (!description) throw new CliError("--description is required", 400, null, 4);
  if (!input.type) throw new CliError("--type is required", 400, null, 4);
  if (!input.severity) throw new CliError("--severity is required", 400, null, 4);
  assertEnum(input.type, BUG_TYPES, "type");
  assertEnum(input.severity, SEVERITIES, "severity");
  assertEnum(input.priority, PRIORITIES, "priority");

  const body: Record<string, unknown> = {
    bugType: input.type,
    severity: input.severity,
    description,
  };
  if (input.steps) body.stepsToReproduce = input.steps;
  if (input.priority) body.priority = input.priority;

  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "POST", path: "/api/bugs/report", body } };
  }
  const res = await client.post<{ bugReportId?: number; referenceNumber?: string }>(
    "/api/bugs/report",
    body,
    { headers: writeFlagsToHeaders({ reason: input.reason }) }
  );
  return { bugReportId: res.bugReportId, referenceNumber: res.referenceNumber };
}

export interface BugListOpts {
  status?: string;
  severity?: string;
  type?: string;
  owner?: number;
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: string;
}

/**
 * GET /api/bugs/list — permission-filtered server-side (a non-admin sees their
 * own + company reports; admins see all and may filter by --owner). Projects
 * the { success, data } envelope into the universal ListEnvelope.
 */
export async function runBugList(
  client: ApiClient,
  opts: BugListOpts
): Promise<ListEnvelope<Record<string, unknown>>> {
  assertEnum(opts.status, STATUSES, "status");
  assertEnum(opts.severity, SEVERITIES, "severity");
  assertEnum(opts.type, BUG_TYPES, "type");
  assertEnum(opts.orderBy, ORDER_BY, "order-by");
  assertEnum(opts.order, ORDER_DIR, "order");

  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.severity) qs.set("severity", opts.severity);
  if (opts.type) qs.set("bugType", opts.type);
  if (opts.owner !== undefined) qs.set("ownerAsiakasId", String(opts.owner));
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
  if (opts.orderBy) qs.set("orderBy", opts.orderBy);
  if (opts.order) qs.set("orderDirection", opts.order);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  const res = await client.get<unknown>(`/api/bugs/list${suffix}`);
  const data = unwrapData(res);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const now = Date.now();
  const items = rows.map((r) => withAge(r, now));
  const truncated = opts.limit !== undefined && items.length >= opts.limit;
  return { items, nextCursor: null, count: items.length, truncated };
}

/** GET /api/bugs/:id — one report with its comments + attachments inline. */
export async function runBugGet(client: ApiClient, id: number): Promise<unknown> {
  const res = await client.get<unknown>(`/api/bugs/${id}`);
  const data = unwrapData(res);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return withAge(data as Record<string, unknown>, Date.now());
  }
  return data;
}

export interface BugCommentInput {
  body?: string;
  reason?: string;
  dryRun?: boolean;
}

/** POST /api/bugs/:id/comment — add a comment (owner / same-company / admin). */
export async function runBugComment(
  client: ApiClient,
  id: number,
  input: BugCommentInput
): Promise<Record<string, unknown>> {
  const comment = input.body?.trim();
  if (!comment) throw new CliError("--body is required", 400, null, 4);
  const payload = { comment };
  const path = `/api/bugs/${id}/comment`;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "POST", path, body: payload } };
  }
  const res = await client.post<{ commentId?: number }>(path, payload, {
    headers: writeFlagsToHeaders({ reason: input.reason }),
  });
  return { commentId: res.commentId };
}

export interface BugAdminUpdateInput {
  status?: string;
  priority?: string;
  notes?: string;
  resolution?: string;
  assign?: number;
  reason?: string;
  dryRun?: boolean;
}

/** PUT /api/bugs/admin/:id — developer-only triage of status/priority/notes/resolution/assignee. */
export async function runBugAdminUpdate(
  client: ApiClient,
  id: number,
  input: BugAdminUpdateInput
): Promise<unknown> {
  assertEnum(input.status, STATUSES, "status");
  assertEnum(input.priority, PRIORITIES, "priority");
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body.status = input.status;
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.notes !== undefined) body.adminNotes = input.notes;
  if (input.resolution !== undefined) body.resolution = input.resolution;
  if (input.assign !== undefined) body.assignedTo = input.assign;
  if (Object.keys(body).length === 0) {
    throw new CliError(
      "provide at least one of --status / --priority / --notes / --resolution / --assign",
      400,
      null,
      4
    );
  }
  const path = `/api/bugs/admin/${id}`;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "PUT", path, body } };
  }
  const res = await client.put<unknown>(path, body, {
    headers: writeFlagsToHeaders({ reason: input.reason }),
  });
  return unwrapData(res);
}

export interface BugAdminAssignInput {
  to?: number;
  reason?: string;
  dryRun?: boolean;
}

/** POST /api/bugs/admin/:id/assign — developer-only; also flips status→in-progress. */
export async function runBugAdminAssign(
  client: ApiClient,
  id: number,
  input: BugAdminAssignInput
): Promise<unknown> {
  if (input.to === undefined || !Number.isInteger(input.to) || input.to <= 0) {
    throw new CliError("--to <personId> is required (a positive integer)", 400, null, 4);
  }
  const body = { assignToPersonId: input.to };
  const path = `/api/bugs/admin/${id}/assign`;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "POST", path, body } };
  }
  const res = await client.post<unknown>(path, body, {
    headers: writeFlagsToHeaders({ reason: input.reason }),
  });
  return unwrapData(res);
}

/** GET /api/bugs/admin/statistics — developer-only aggregate counts. */
export async function runBugAdminStats(
  client: ApiClient,
  opts: { owner?: number }
): Promise<unknown> {
  const qs = opts.owner !== undefined ? `?ownerAsiakasId=${opts.owner}` : "";
  const res = await client.get<unknown>(`/api/bugs/admin/statistics${qs}`);
  return unwrapData(res);
}

export interface BugAdminDeleteInput {
  reason?: string;
  dryRun?: boolean;
}

/** DELETE /api/bugs/admin/:id — developer-only, irreversible. --reason required. */
export async function runBugAdminDelete(
  client: ApiClient,
  id: number,
  input: BugAdminDeleteInput
): Promise<Record<string, unknown>> {
  const reason = input.reason?.trim();
  if (!reason) throw new CliError("--reason is required for delete", 400, null, 4);
  const path = `/api/bugs/admin/${id}`;
  if (input.dryRun) {
    return {
      dryRun: true,
      wouldSend: { method: "DELETE", path, headers: { "X-Action-Reason": reason } },
    };
  }
  await client.delete<unknown>(path, { headers: writeFlagsToHeaders({ reason }) });
  return { success: true, bugReportId: id };
}

/**
 * Register `ib dev bug` (create/list/get/comment) + the developer-only
 * `ib dev bug admin` subgroup (update/assign/stats/delete). Each leaf's --help is
 * replaced by its CommandSpec via attachRichHelp; the two group commands render
 * computed group help.
 */
export function registerBugCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const bug = parent
    .command("bug", { hidden: !!opts.hidden })
    .description("File, read, and triage bug reports (bugReport system)");

  bug
    .command("create")
    .description("File a bug report (opens a GitHub issue + emails admins)")
    .requiredOption(
      "--type <type>",
      "ui-display-issue | functionality-error | performance-problem | data-incorrect | other"
    )
    .requiredOption("--severity <sev>", "critical | major | minor | cosmetic")
    .requiredOption("--description <text>", "What is wrong")
    .option("--steps <text>", "Steps to reproduce")
    .option("--priority <p>", "low | medium | high | urgent (default: derived from severity)")
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .option("--dry-run", "Preview the payload without sending (client-side)")
    .action(async (opts: BugCreateInput) => {
      try {
        writeJson(await runBugCreate(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  bug
    .command("list")
    .description("List bug reports (permission-filtered; admins see all)")
    .option("--status <s>", "new | in-progress | resolved | closed")
    .option("--severity <s>", "critical | major | minor | cosmetic")
    .option(
      "--type <t>",
      "ui-display-issue | functionality-error | performance-problem | data-incorrect | other"
    )
    .option("--owner <asiakasId>", "Filter by owning tenant (admins only; ignored otherwise)", Number)
    .option("--limit <n>", "Max rows", Number)
    .option("--offset <n>", "Pagination offset", Number)
    .option("--order-by <f>", "createdAt | updatedAt | severity | status | bugType | bugReportId", "createdAt")
    .option("--order <dir>", "asc | desc", "desc")
    .action(async (opts: BugListOpts) => {
      try {
        writeJson(await runBugList(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  bug
    .command("get <bugReportId>")
    .description("Fetch one bug report with its comments + attachments")
    .action(async (idStr: string) => {
      try {
        writeJson(await runBugGet(await getClient(), parseId(idStr, "bugId")));
      } catch (e) {
        exitWithError(e);
      }
    });

  bug
    .command("comment <bugReportId>")
    .description("Add a comment to a bug report")
    .requiredOption("--body <text>", "Comment text")
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .option("--dry-run", "Preview without sending (client-side)")
    .action(async (idStr: string, opts: BugCommentInput) => {
      try {
        writeJson(await runBugComment(await getClient(), parseId(idStr, "bugId"), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  const admin = bug
    .command("admin")
    .description("Developer-only triage: update, assign, stats, delete");

  admin
    .command("update <bugReportId>")
    .description("Update status/priority/notes/resolution/assignee (developer-only)")
    .option("--status <s>", "new | in-progress | resolved | closed")
    .option("--priority <p>", "low | medium | high | urgent")
    .option("--notes <text>", "Admin notes")
    .option("--resolution <text>", "Resolution text")
    .option("--assign <personId>", "Assign to a developer", Number)
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .option("--dry-run", "Preview without sending (client-side)")
    .action(async (idStr: string, opts: BugAdminUpdateInput) => {
      try {
        writeJson(await runBugAdminUpdate(await getClient(), parseId(idStr, "bugId"), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("assign <bugReportId>")
    .description("Assign a report to a developer (sets status→in-progress; developer-only)")
    .requiredOption("--to <personId>", "Assignee personId", Number)
    .option("--reason <text>", "Audit reason (X-Action-Reason)")
    .option("--dry-run", "Preview without sending (client-side)")
    .action(async (idStr: string, opts: BugAdminAssignInput) => {
      try {
        writeJson(await runBugAdminAssign(await getClient(), parseId(idStr, "bugId"), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("stats")
    .description("Bug report statistics (developer-only)")
    .option("--owner <asiakasId>", "Scope to one tenant", Number)
    .action(async (opts: { owner?: number }) => {
      try {
        writeJson(await runBugAdminStats(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("delete <bugReportId>")
    .description("Delete a bug report (irreversible; developer-only). Requires --reason.")
    .requiredOption("--reason <text>", "Why (required; X-Action-Reason)")
    .option("--dry-run", "Preview without sending (client-side)")
    .action(async (idStr: string, opts: BugAdminDeleteInput) => {
      try {
        writeJson(await runBugAdminDelete(await getClient(), parseId(idStr, "bugId"), opts));
      } catch (e) {
        exitWithError(e);
      }
    });
}
