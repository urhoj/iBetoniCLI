/**
 * `ib message support` — Operator → platform support escalations.
 *
 * The lifecycle verbs for the "Operator → Sysadmin support" feature:
 *   contact   open (or append to) a support thread about a pumppuRequest/keikka
 *   inbox     developer triage queue (open|resolved|all)
 *   resolve   mark a support thread resolved (or --reopen)
 *
 * Reading/replying to a support thread reuses the EXISTING chat verbs — a
 * support thread is a normal messageThread (the backend admits admins via a
 * bypass), so once a thread exists you read it with `ib message chat list
 * <threadId>` and reply with `ib message chat send <threadId> --body ...`.
 *
 * `contact` is a REAL write (POST /api/messages/support) → honours the
 * read-only write-lock (NOT sent as meta). `resolve` is a developer-only write
 * (PATCH). Both resolve `--dry-run` CLIENT-SIDE (mirroring chat `send` /
 * `feedback`): the dry-run prints `{ dryRun, wouldSend }` and issues NO network
 * call, so it is safe-by-construction and works under --read-only.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { CliError } from "../../../api/errors.js";
import type { ListEnvelope } from "../../../api/envelopes.js";
import { writeJson, exitWithError } from "../../../output/json.js";

const STATUSES = ["open", "resolved", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

const CONTEXT_TYPES = ["pumppuRequest", "keikka"] as const;
type ContextType = (typeof CONTEXT_TYPES)[number];

type Row = Record<string, unknown>;

/**
 * GET /api/messages/support/inbox — developer-only triage queue. Projects the
 * backend `{ items, count, truncated }` into the universal list envelope.
 */
export async function runSupportInbox(
  client: ApiClient,
  opts: { status?: string; limit?: number }
): Promise<ListEnvelope<Row>> {
  const status = opts.status ?? "open";
  if (!STATUSES.includes(status as StatusFilter)) {
    throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
  }
  const qs = new URLSearchParams();
  qs.set("status", status);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  const res = await client.get<{ items?: Row[]; count?: number; truncated?: boolean }>(
    `/api/messages/support/inbox?${qs.toString()}`
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  return {
    items,
    nextCursor: null,
    count: typeof res?.count === "number" ? res.count : items.length,
    truncated: Boolean(res?.truncated),
  };
}

export interface SupportContactInput {
  contextType: string;
  contextId: number;
  body: string;
  dryRun?: boolean;
}

/**
 * POST /api/messages/support — open (or append to) a support thread. A REAL
 * write: NOT sent as meta, so the read-only write-lock blocks it. `--dry-run`
 * resolves client-side (prints the payload, never POSTs).
 */
export async function runSupportContact(
  client: ApiClient,
  input: SupportContactInput
): Promise<Row> {
  if (!CONTEXT_TYPES.includes(input.contextType as ContextType)) {
    throw new CliError(
      `contextType must be one of: ${CONTEXT_TYPES.join(", ")} (set --keikka or --tarjous)`,
      400,
      null,
      4
    );
  }
  if (!Number.isFinite(input.contextId) || input.contextId <= 0) {
    throw new CliError("contextId must be a positive number (--keikka or --tarjous)", 400, null, 4);
  }
  const body = String(input.body ?? "").trim();
  if (!body) {
    throw new CliError("--body cannot be empty", 400, null, 4);
  }
  const payload: Row = {
    contextType: input.contextType,
    contextId: input.contextId,
    body,
  };
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "POST", path: "/api/messages/support", body: payload } };
  }
  return client.post<Row>("/api/messages/support", payload);
}

export interface SupportResolveInput {
  reopen?: boolean;
  dryRun?: boolean;
}

/**
 * PATCH /api/messages/support/:threadId/status — developer-only. Marks the
 * support thread resolved (or `--reopen` → open). A REAL write (blocked under
 * --read-only); `--dry-run` previews the body client-side without sending.
 */
export async function runSupportResolve(
  client: ApiClient,
  threadId: number,
  input: SupportResolveInput
): Promise<Row> {
  if (!Number.isFinite(threadId) || threadId <= 0) {
    throw new CliError("threadId must be a positive number", 400, null, 4);
  }
  const status = input.reopen ? "open" : "resolved";
  const path = `/api/messages/support/${threadId}/status`;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "PATCH", path, body: { status } } };
  }
  return client.patch<Row>(path, { status });
}

/**
 * Register `ib message support` — the Operator → platform escalation lifecycle:
 *   contact   POST /api/messages/support           (any user; a real write)
 *   inbox     GET  /api/messages/support/inbox      (developer-only)
 *   resolve   PATCH /api/messages/support/:id/status (developer-only; a write)
 *
 * Read/reply with the existing `ib message chat list/send <threadId>`.
 */
export function registerMessageSupportCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const support = parent
    .command("support")
    .description("Operator → platform support escalations");

  support
    .command("inbox")
    .description("Support triage queue (developer-only): open | resolved | all")
    .option("--status <status>", "open | resolved | all", "open")
    .option("--limit <n>", "Max rows", Number)
    .action(async (opts: { status?: string; limit?: number }) => {
      try {
        writeJson(await runSupportInbox(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  support
    .command("contact")
    .description(
      "Open (or append to) a support thread about a tarjous or keikka. A real write; --dry-run previews the payload CLIENT-SIDE (no POST). Reply later with `ib message chat send <threadId>`."
    )
    .option("--tarjous <id>", "pumppuRequestId this escalation is about", Number)
    .option("--keikka <id>", "keikkaId this escalation is about", Number)
    .requiredOption("--body <text>", "The message to support")
    // client-side --dry-run (the /support routes have no server X-Dry-Run guard); no
    // audit headers — contact persists no reason and ensureSupportThread is idempotent.
    .option("--dry-run", "Print the payload without sending (client-side)")
    .action(
      async (opts: { tarjous?: number; keikka?: number; body: string; dryRun?: boolean }) => {
        try {
          // Number-coerced flags turn "abc" into NaN (which is !== undefined), so a
          // bare presence check would skip this guard and fire a misleading downstream
          // error. Gate on finiteness instead. (run* keeps its own guard as defence.)
          const contextId = Number.isFinite(opts.keikka) ? opts.keikka : opts.tarjous;
          if (!Number.isFinite(contextId)) {
            throw new CliError("Provide --keikka or --tarjous (positive integer)", 400, null, 4);
          }
          const contextType = Number.isFinite(opts.keikka) ? "keikka" : "pumppuRequest";
          writeJson(
            await runSupportContact(await getClient(), {
              contextType,
              contextId: contextId as number,
              body: opts.body,
              dryRun: opts.dryRun,
            })
          );
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  support
    .command("resolve <threadId>")
    .description(
      "Mark a support thread resolved, or --reopen it (developer-only; a write). --dry-run previews the body client-side."
    )
    .option("--reopen", "Set status back to open instead of resolved")
    // client-side --dry-run (the status PATCH has no server X-Dry-Run guard); no
    // audit headers — the status change persists no reason.
    .option("--dry-run", "Print the update body without sending (client-side)")
    .action(async (threadIdStr: string, opts: { reopen?: boolean; dryRun?: boolean }) => {
      try {
        writeJson(await runSupportResolve(await getClient(), Number(threadIdStr), opts));
      } catch (e) {
        exitWithError(e);
      }
    });
}
