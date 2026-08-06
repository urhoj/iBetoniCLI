import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../../api/writeFlags.js";
import { writeJson } from "../../../output/json.js";
import { guarded } from "../../_shared/action.js";
import { addThreadTargetOption, resolveThreadId, targetFrom, } from "../chat/resolveThread.js";
// --dry-run on every thread write resolves CLIENT-SIDE: the messages routes
// honour no X-Dry-Run (messageRoutes.js has no guard), so a dry-run that POSTed
// would actually persist (fb#244; same footgun class as fb#76). Each run* fn
// short-circuits before the request and echoes the would-be call instead.
export async function runThreadArchive(client, threadId, flags) {
    if (flags.dryRun)
        return { dryRun: true, wouldArchive: { method: "POST", path: `/api/messages/threads/${threadId}/archive`, threadId } };
    return client.post(`/api/messages/threads/${threadId}/archive`, {}, { headers: writeFlagsToHeaders(flags) });
}
export async function runThreadReopen(client, threadId, flags) {
    if (flags.dryRun)
        return { dryRun: true, wouldReopen: { method: "POST", path: `/api/messages/threads/${threadId}/reopen`, threadId } };
    return client.post(`/api/messages/threads/${threadId}/reopen`, {}, { headers: writeFlagsToHeaders(flags) });
}
export async function runThreadRename(client, threadId, title, flags) {
    if (flags.dryRun)
        return { dryRun: true, wouldRename: { method: "PATCH", path: `/api/messages/threads/${threadId}`, threadId, title } };
    return client.patch(`/api/messages/threads/${threadId}`, { title }, { headers: writeFlagsToHeaders(flags) });
}
export async function runThreadParticipantAdd(client, threadId, personId, opts) {
    const body = { personId };
    if (opts.role)
        body.role = opts.role;
    if (opts.dryRun)
        return { dryRun: true, wouldAdd: { method: "POST", path: `/api/messages/threads/${threadId}/participants`, threadId, ...body } };
    return client.post(`/api/messages/threads/${threadId}/participants`, body, { headers: writeFlagsToHeaders(opts) });
}
export async function runThreadParticipantRemove(client, threadId, personId, flags) {
    if (flags.dryRun)
        return { dryRun: true, wouldRemove: { method: "DELETE", path: `/api/messages/threads/${threadId}/participants/${personId}`, threadId, personId } };
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
export function registerMessageThreadCommands(parent, getClient) {
    const t = parent
        .command("thread")
        .description("Thread lifecycle: archive/reopen, rename, participants (manager-gated)");
    const archiveCmd = addThreadTargetOption(t.command("archive [threadId]"));
    addWriteFlagsToCommand(archiveCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(idStr, opts));
        writeJson(await runThreadArchive(client, id, opts));
    }));
    const reopenCmd = addThreadTargetOption(t.command("reopen [threadId]"));
    addWriteFlagsToCommand(reopenCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(idStr, opts));
        writeJson(await runThreadReopen(client, id, opts));
    }));
    const renameCmd = addThreadTargetOption(t.command("rename [threadId]"))
        .requiredOption("--title <text>", 'New thread title (max 200 chars; "" clears)');
    addWriteFlagsToCommand(renameCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(idStr, opts));
        writeJson(await runThreadRename(client, id, String(opts.title ?? "").trim(), opts));
    }));
    const p = t
        .command("participant")
        .description("Add/remove a thread participant (must be a member of the owning company)");
    const addCmd = addThreadTargetOption(p.command("add [threadId]"))
        .requiredOption("--person <id>", "personId to add", Number)
        .option("--role <role>", "Participant role (customer|pumppu|betoni|lattia|support|provider; default pumppu)");
    addWriteFlagsToCommand(addCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(idStr, opts));
        writeJson(await runThreadParticipantAdd(client, id, Number(opts.person), opts));
    }));
    const remCmd = addThreadTargetOption(p.command("remove [threadId]"))
        .requiredOption("--person <id>", "personId to remove", Number);
    addWriteFlagsToCommand(remCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(idStr, opts));
        writeJson(await runThreadParticipantRemove(client, id, Number(opts.person), opts));
    }));
}
//# sourceMappingURL=index.js.map