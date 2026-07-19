import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../../api/writeFlags.js";
import { writeJson, exitWithError } from "../../../output/json.js";
import { resolveThreadId } from "../chat/resolveThread.js";
import { parseOptionalId } from "../../../targets.js";

// --dry-run on every thread write resolves CLIENT-SIDE: the messages routes
// honour no X-Dry-Run (messageRoutes.js has no guard), so a dry-run that POSTed
// would actually persist (fb#244; same footgun class as fb#76). Each run* fn
// short-circuits before the request and echoes the would-be call instead.

export async function runThreadArchive(client: ApiClient, threadId: number, flags: WriteFlags): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldArchive: { method: "POST", path: `/api/messages/threads/${threadId}/archive`, threadId } };
  return client.post(`/api/messages/threads/${threadId}/archive`, {}, { headers: writeFlagsToHeaders(flags) });
}

export async function runThreadReopen(client: ApiClient, threadId: number, flags: WriteFlags): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldReopen: { method: "POST", path: `/api/messages/threads/${threadId}/reopen`, threadId } };
  return client.post(`/api/messages/threads/${threadId}/reopen`, {}, { headers: writeFlagsToHeaders(flags) });
}

export async function runThreadRename(client: ApiClient, threadId: number, title: string, flags: WriteFlags): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldRename: { method: "PATCH", path: `/api/messages/threads/${threadId}`, threadId, title } };
  return client.patch(`/api/messages/threads/${threadId}`, { title }, { headers: writeFlagsToHeaders(flags) });
}

export async function runThreadParticipantAdd(client: ApiClient, threadId: number, personId: number, opts: WriteFlags & { role?: string }): Promise<unknown> {
  const body: Record<string, unknown> = { personId };
  if (opts.role) body.role = opts.role;
  if (opts.dryRun) return { dryRun: true, wouldAdd: { method: "POST", path: `/api/messages/threads/${threadId}/participants`, threadId, ...body } };
  return client.post(`/api/messages/threads/${threadId}/participants`, body, { headers: writeFlagsToHeaders(opts) });
}

export async function runThreadParticipantRemove(client: ApiClient, threadId: number, personId: number, flags: WriteFlags): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldRemove: { method: "DELETE", path: `/api/messages/threads/${threadId}/participants/${personId}`, threadId, personId } };
  return client.delete(`/api/messages/threads/${threadId}/participants/${personId}`, { headers: writeFlagsToHeaders(flags) });
}

/**
 * Register `ib message thread` — thread lifecycle writes (manager-gated):
 *   archive [threadId]                  set archivedAt (thread read-only)
 *   reopen  [threadId]                  clear archivedAt
 *   rename  [threadId] --title <text>   set/clear messageThread.title
 *   participant add    [threadId] --person <id>   add owning-company colleague
 *   participant remove [threadId] --person <id>   soft-remove (leftAt = now)
 *
 * Every leaf resolves the target thread from a raw threadId positional OR
 * --tarjous <pumppuRequestId> via resolveThreadId (reuses the chat resolver).
 * Authorization is server-side (canManageThread: owning-company admin or
 * sysadmin/developer); no tier tag here.
 */
export function registerMessageThreadCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const t = parent
    .command("thread")
    .description("Thread lifecycle: archive/reopen, rename, participants (manager-gated)");

  const archiveCmd = t
    .command("archive [threadId]")
    .description("Archive a thread (becomes read-only; send/edit/restore then 409)")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number);
  addWriteFlagsToCommand(archiveCmd).action(
    async (idStr: string | undefined, opts: WriteFlags & { tarjous?: number }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: parseOptionalId(idStr, "threadId"), tarjous: opts.tarjous });
        writeJson(await runThreadArchive(client, id, opts));
      } catch (e) { exitWithError(e); }
    }
  );

  const reopenCmd = t
    .command("reopen [threadId]")
    .description("Reopen an archived thread (clears archivedAt)")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number);
  addWriteFlagsToCommand(reopenCmd).action(
    async (idStr: string | undefined, opts: WriteFlags & { tarjous?: number }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: parseOptionalId(idStr, "threadId"), tarjous: opts.tarjous });
        writeJson(await runThreadReopen(client, id, opts));
      } catch (e) { exitWithError(e); }
    }
  );

  const renameCmd = t
    .command("rename [threadId]")
    .description('Set the thread title (empty --title clears it; max 200 chars; deploy-gated on messageThread.title migration)')
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .requiredOption("--title <text>", 'New thread title (max 200 chars; "" clears)');
  addWriteFlagsToCommand(renameCmd).action(
    async (idStr: string | undefined, opts: WriteFlags & { tarjous?: number; title: string }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: parseOptionalId(idStr, "threadId"), tarjous: opts.tarjous });
        writeJson(await runThreadRename(client, id, String(opts.title ?? "").trim(), opts));
      } catch (e) { exitWithError(e); }
    }
  );

  const p = t
    .command("participant")
    .description("Add/remove a thread participant (must be a member of the owning company)");

  const addCmd = p
    .command("add [threadId]")
    .description("Add a colleague to the thread (must be a member of the owning company)")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .requiredOption("--person <id>", "personId to add", Number)
    .option("--role <role>", "Participant role (customer|pumppu|betoni|lattia|support|provider; default pumppu)");
  addWriteFlagsToCommand(addCmd).action(
    async (idStr: string | undefined, opts: WriteFlags & { tarjous?: number; person: number; role?: string }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: parseOptionalId(idStr, "threadId"), tarjous: opts.tarjous });
        writeJson(await runThreadParticipantAdd(client, id, Number(opts.person), opts));
      } catch (e) { exitWithError(e); }
    }
  );

  const remCmd = p
    .command("remove [threadId]")
    .description("Soft-remove a participant (sets leftAt = now)")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .requiredOption("--person <id>", "personId to remove", Number);
  addWriteFlagsToCommand(remCmd).action(
    async (idStr: string | undefined, opts: WriteFlags & { tarjous?: number; person: number }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: parseOptionalId(idStr, "threadId"), tarjous: opts.tarjous });
        writeJson(await runThreadParticipantRemove(client, id, Number(opts.person), opts));
      } catch (e) { exitWithError(e); }
    }
  );
}
