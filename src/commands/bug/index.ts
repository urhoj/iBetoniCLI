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
