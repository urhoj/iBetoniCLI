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
  const items = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const truncated = opts.limit !== undefined && items.length >= opts.limit;
  return { items, nextCursor: null, count: items.length, truncated };
}

/** GET /api/bugs/:id — one report with its comments + attachments inline. */
export async function runBugGet(client: ApiClient, id: number): Promise<unknown> {
  const res = await client.get<unknown>(`/api/bugs/${id}`);
  return unwrapData(res);
}
