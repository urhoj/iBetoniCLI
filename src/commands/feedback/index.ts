/**
 * `ib feedback` — file and triage CLI improvement proposals / trouble reports.
 *
 * When an AI (or CI) hits friction using `ib`, it files a freetext note here so
 * the CLI can be improved. Submission is SILENT server-side (no GitHub issue,
 * no email, no notification — distinct from `bugReport`); a developer-gated
 * analyzer skill reads them back via `ib feedback list` and closes the loop.
 *
 * `create` is sent as a META request → exempt from the read-only write-lock, so
 * an agent running `--read-only` can still report friction. `list`/`get`/`resolve`
 * are developer-only; `resolve` is a real write (blocked under read-only).
 * `--dry-run` (create + resolve) resolves CLIENT-SIDE: prints the payload, no send.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";

const KINDS = ["improvement", "bug"] as const;
type Kind = (typeof KINDS)[number];
const STATUSES = ["open", "reviewed", "applied", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

export interface FeedbackCreateInput {
  description: string;
  kind?: string;
  command?: string;
  error?: string;
  dryRun?: boolean;
}

interface FeedbackCreateBody {
  kind: Kind;
  description: string;
  command?: string;
  error?: string;
}

function buildCreateBody(input: FeedbackCreateInput): FeedbackCreateBody {
  const description = input.description?.trim();
  if (!description) {
    throw new CliError("description is required", 400, null, 4);
  }
  const body: FeedbackCreateBody = {
    kind: KINDS.includes(input.kind as Kind) ? (input.kind as Kind) : "improvement",
    description,
  };
  if (input.command) body.command = input.command;
  if (input.error) body.error = input.error;
  return body;
}

/**
 * POST /api/feedback — file a proposal / trouble report. `meta: true` exempts it
 * from the read-only write-lock. `--dry-run` prints the payload and never POSTs.
 */
export async function runFeedbackCreate(
  client: ApiClient,
  input: FeedbackCreateInput
): Promise<Record<string, unknown>> {
  const body = buildCreateBody(input);
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "POST", path: "/api/feedback", body } };
  }
  return client.post<Record<string, unknown>>("/api/feedback", body, { meta: true });
}

/**
 * GET /api/feedback — developer-only. Projects the backend array into the
 * universal `{ items, nextCursor, count }` envelope.
 */
export async function runFeedbackList(
  client: ApiClient,
  opts: { status?: string; kind?: string; limit?: number; offset?: number }
): Promise<ListEnvelope<Record<string, unknown>>> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.kind) qs.set("kind", opts.kind);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const rows = await client.get<Record<string, unknown>[]>(`/api/feedback${suffix}`);
  const items = Array.isArray(rows) ? rows : [];
  return { items, nextCursor: null, count: items.length };
}

/** GET /api/feedback/:id — developer-only single row. */
export async function runFeedbackGet(
  client: ApiClient,
  id: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(`/api/feedback/${id}`);
}

export interface FeedbackResolveInput {
  status?: string;
  note?: string;
  dryRun?: boolean;
}

/**
 * PUT /api/feedback/:id — developer triage (status and/or resolution note).
 * A REAL write — blocked under --read-only (exit 3). `--dry-run` previews the
 * body client-side without sending.
 */
export async function runFeedbackResolve(
  client: ApiClient,
  id: number,
  input: FeedbackResolveInput
): Promise<Record<string, unknown>> {
  if (input.status !== undefined && !STATUSES.includes(input.status as Status)) {
    throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
  }
  if (input.status === undefined && input.note === undefined) {
    throw new CliError("Provide --status and/or --note", 400, null, 4);
  }
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body.status = input.status;
  if (input.note !== undefined) body.resolution = input.note;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
  }
  return client.put<Record<string, unknown>>(`/api/feedback/${id}`, body);
}

/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; a real write)
 */
export function registerFeedbackCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const f = parent
    .command("feedback")
    .description("File & triage CLI improvement proposals / trouble reports");

  f.command("create <description>")
    .description(
      "File a proposal/trouble report. Silent server-side; works under --read-only."
    )
    .option("--kind <kind>", "improvement | bug", "improvement")
    .option("--command <argv>", "The ib command/argv that triggered the friction")
    .option("--error <msg>", "Error message you hit, if any")
    .option("--dry-run", "Print the payload without sending (client-side)")
    .action(
      async (
        description: string,
        opts: { kind?: string; command?: string; error?: string; dryRun?: boolean }
      ) => {
        try {
          const client = await getClient();
          writeJson(await runFeedbackCreate(client, { description, ...opts }));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  f.command("list")
    .description("List feedback for triage (developer-only)")
    .option("--status <status>", "open | reviewed | applied | dismissed")
    .option("--kind <kind>", "improvement | bug")
    .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
    .option("--offset <n>", "Pagination offset", Number)
    .action(
      async (opts: { status?: string; kind?: string; limit?: number; offset?: number }) => {
        try {
          writeJson(await runFeedbackList(await getClient(), opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  f.command("get <id>")
    .description("Fetch one feedback row by id (developer-only)")
    .action(async (idStr: string) => {
      try {
        writeJson(await runFeedbackGet(await getClient(), Number(idStr)));
      } catch (e) {
        exitWithError(e);
      }
    });

  f.command("resolve <id>")
    .description(
      "Triage a feedback row: set status and/or note (developer-only; a write)"
    )
    .option("--status <status>", "open | reviewed | applied | dismissed")
    .option("--note <text>", "Resolution note stored on the row")
    .option("--dry-run", "Print the update body without sending (client-side)")
    .action(
      async (
        idStr: string,
        opts: { status?: string; note?: string; dryRun?: boolean }
      ) => {
        try {
          writeJson(await runFeedbackResolve(await getClient(), Number(idStr), opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );
}
