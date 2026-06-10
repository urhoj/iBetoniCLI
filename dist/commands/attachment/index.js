import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { CliError } from "../../api/errors.js";
/** Wire entity names ↔ commander option keys. Mirrors backend ENTITY_COLUMNS. */
const ENTITY_OPTS = [
    { optKey: "keikka", flag: "--keikka <id>", entity: "keikka", blurb: "keikkaId" },
    { optKey: "vehicle", flag: "--vehicle <id>", entity: "vehicle", blurb: "vehicleId" },
    { optKey: "person", flag: "--person <id>", entity: "person", blurb: "personId" },
    { optKey: "customer", flag: "--customer <id>", entity: "customer", blurb: "asiakasId" },
    { optKey: "worksite", flag: "--worksite <id>", entity: "worksite", blurb: "tyomaaId" },
    { optKey: "sijainti", flag: "--sijainti <id>", entity: "sijainti", blurb: "sijaintiId" },
    { optKey: "tuote", flag: "--tuote <id>", entity: "tuote", blurb: "tuoteId" },
    { optKey: "bugReport", flag: "--bug-report <id>", entity: "bugReport", blurb: "bugReportId" },
    { optKey: "request", flag: "--request <id>", entity: "request", blurb: "Jerry pumppuRequestId" },
    { optKey: "offer", flag: "--offer <id>", entity: "offer", blurb: "Jerry pumppuOfferId" },
];
const ENTITY_WORDS = ENTITY_OPTS.map((e) => e.entity);
function addEntityFlags(cmd) {
    for (const e of ENTITY_OPTS) {
        cmd.option(e.flag, `Target = ${e.blurb}`, (s) => Number(s));
    }
    return cmd;
}
/** Exactly one entity flag must be set. Exported for tests. */
export function resolveEntityTarget(opts) {
    const hits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
    if (hits.length !== 1) {
        failWith(`Exactly one entity flag required (got ${hits.length}): ${ENTITY_OPTS.map((e) => e.flag.split(" ")[0]).join(" | ")}`, 4);
    }
    const entityId = Number(opts[hits[0].optKey]);
    if (!Number.isInteger(entityId) || entityId <= 0) {
        failWith(`${hits[0].flag.split(" ")[0]} must be a positive integer`, 4);
    }
    return { entity: hits[0].entity, entityId };
}
/** Accepts "keikka" | "bug-report" | "bugReport" etc. for the detach positional. */
export function normalizeEntityWord(raw) {
    const name = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!ENTITY_WORDS.includes(name)) {
        failWith(`Unknown entity '${raw}'. Valid: ${ENTITY_WORDS.join(", ")}`, 4);
    }
    return name;
}
const MIME_BY_EXT = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", heic: "image/heic", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip", json: "application/json",
};
/** Exported for tests. Fallback application/octet-stream; override with --mime. */
export function mimeFromExtension(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
/** Resolve --group/--type values that may be names ("tilaus") or ids ("1"). */
export async function resolveGroupAndType(client, opts) {
    let cached = null;
    const load = async () => (cached ??= await runAttachmentTypes(client));
    const resolve = async (val, kind) => {
        if (val === undefined)
            return undefined;
        if (/^\d+$/.test(val))
            return Number(val);
        const data = await load();
        const list = kind === "group" ? data.groups : data.types;
        const nameKey = kind === "group" ? "attachmentGroupName" : "attachmentTypeName";
        const idKey = kind === "group" ? "attachmentGroupId" : "attachmentTypeId";
        const hit = list.find((r) => String(r[nameKey]).toLowerCase() === val.toLowerCase());
        if (!hit) {
            failWith(`Unknown ${kind} '${val}'. Valid: ${list.map((r) => `${r[idKey]}=${r[nameKey]}`).join(", ")}`, 4);
        }
        return Number(hit[idKey]);
    };
    return { groupId: await resolve(opts.group, "group"), typeId: await resolve(opts.type, "type") };
}
// ── Pure run functions ───────────────────────────────────────────────────────
/** GET /api/cli/attachment/list — generic list-by-entity. */
export async function runAttachmentList(client, target, opts) {
    const params = new URLSearchParams({ entity: target.entity, id: String(target.entityId) });
    if (opts.groupId !== undefined)
        params.set("group", String(opts.groupId));
    if (opts.typeId !== undefined)
        params.set("type", String(opts.typeId));
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    return client.get(`/api/cli/attachment/list?${params.toString()}`);
}
/** GET /api/cli/attachment/get/:id — metadata + names + 1h blobUrl. */
export async function runAttachmentGet(client, attachmentId) {
    return client.get(`/api/cli/attachment/get/${attachmentId}`);
}
/** GET /api/cli/attachment/types — groups + types legend (tenant from JWT). */
export async function runAttachmentTypes(client) {
    return client.get("/api/cli/attachment/types");
}
/** GET /api/cli/attachment/search — text search / orphaned (missing) listing. */
export async function runAttachmentSearch(client, opts) {
    // Manual encodeURIComponent (not URLSearchParams): the backend's qs parser
    // does NOT decode "+" to a space, so free-text q must use %20-encoding.
    const parts = [];
    if (opts.q)
        parts.push(`q=${encodeURIComponent(opts.q)}`);
    if (opts.missing)
        parts.push("missing=1");
    if (opts.limit !== undefined)
        parts.push(`limit=${opts.limit}`);
    const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
    return client.get(`/api/cli/attachment/search${qs}`);
}
// ── Upload / download run functions ──────────────────────────────────────────
/** POST /api/cli/attachment/upload-url — authenticated SAS mint (server picks blob path). */
export async function runAttachmentUploadUrl(client, name) {
    return client.post("/api/cli/attachment/upload-url", { name });
}
/** POST /api/cli/attachment/register — persist metadata after the bytes are in Azure. */
export async function runAttachmentRegister(client, body, flags) {
    return client.post("/api/cli/attachment/register", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * LOCAL upload convenience: readFile → upload-url → PUT to Azure → register.
 * --dry-run is CLIENT-side (validates the file, zero network calls).
 * DENIED on /api/cli/exec + MCP (server-side filesystem — LFI).
 */
export async function runAttachmentUpload(client, filePath, opts, flags) {
    const target = resolveEntityTarget(opts);
    let data;
    try {
        data = await readFile(filePath);
    }
    catch {
        failWith(`Cannot read file: ${filePath}`, 4);
        return; // unreachable; satisfies TS
    }
    const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
    if (data.length > MAX_UPLOAD_BYTES) {
        failWith(`File is ${(data.length / 1024 / 1024).toFixed(1)} MB — max 500 MB for CLI upload`, 4);
    }
    const origFileName = basename(filePath);
    const fileType = flags.mime || mimeFromExtension(origFileName);
    if (flags.dryRun) {
        return {
            dryRun: true,
            wouldUpload: {
                file: resolvePath(filePath), bytes: data.length, fileType,
                entity: target.entity, entityId: target.entityId,
                comment: flags.comment ?? null, groupId: flags.groupId ?? null, typeId: flags.typeId ?? null,
            },
        };
    }
    const minted = (await runAttachmentUploadUrl(client, origFileName));
    const putRes = await fetch(minted.uploadUrl, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob" },
        body: data,
    });
    if (!putRes.ok) {
        throw new CliError(`Azure blob upload failed: HTTP ${putRes.status}`, 0, null, 6);
    }
    return runAttachmentRegister(client, {
        fileName: minted.fileName, origFileName, fileFolder: minted.fileFolder,
        fileType, fileSize: data.length, entity: target.entity, entityId: target.entityId,
        fileComment: flags.comment, attachmentGroupId: flags.groupId, attachmentTypeId: flags.typeId,
    }, { idempotencyKey: flags.idempotencyKey, reason: flags.reason });
}
/**
 * LOCAL download: get → fetch blobUrl → writeFile. Refuses overwrite without force.
 * DENIED on /api/cli/exec + MCP (writes the server's disk) — remote callers fetch blobUrl themselves.
 */
export async function runAttachmentDownload(client, attachmentId, outPath, force) {
    const att = (await runAttachmentGet(client, attachmentId));
    if (!att.blobUrl) {
        throw new CliError("Backend returned no blobUrl (deploy gate? old backend?)", 0, null, 6);
    }
    const fallbackName = att.origFileName ? basename(att.origFileName) : `attachment-${attachmentId}`;
    const target = outPath || fallbackName;
    if (!force && existsSync(target)) {
        failWith(`Refusing to overwrite ${target} (use --force)`, 4);
    }
    const res = await fetch(att.blobUrl);
    if (!res.ok) {
        throw new CliError(`Blob download failed: HTTP ${res.status}`, 0, null, 6);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(target, buf);
    return {
        ok: true, attachmentId, file: resolvePath(target), bytes: buf.length,
        fileType: att.fileType ?? null,
    };
}
/** POST /api/cli/attachment/attach — set ONE entity FK (others untouched). */
export async function runAttachmentAttach(client, attachmentId, opts, flags) {
    const target = resolveEntityTarget(opts);
    return client.post("/api/cli/attachment/attach", { attachmentId, entity: target.entity, entityId: target.entityId }, { headers: writeFlagsToHeaders(flags) });
}
/** POST /api/cli/attachment/detach — clear ONE entity FK. */
export async function runAttachmentDetach(client, attachmentId, entityWord, flags) {
    const entity = normalizeEntityWord(entityWord);
    return client.post("/api/cli/attachment/detach", { attachmentId, entity }, { headers: writeFlagsToHeaders(flags) });
}
/** PATCH /api/cli/attachment/:id — server read-merges; send only provided fields. */
export async function runAttachmentUpdate(client, attachmentId, fields, flags) {
    const body = {};
    if (fields.fileComment !== undefined)
        body.fileComment = fields.fileComment;
    if (fields.liitaLaskuun !== undefined)
        body.liitaLaskuun = fields.liitaLaskuun;
    if (fields.attachmentGroupId !== undefined)
        body.attachmentGroupId = fields.attachmentGroupId;
    if (fields.attachmentTypeId !== undefined)
        body.attachmentTypeId = fields.attachmentTypeId;
    return client.patch(`/api/cli/attachment/${attachmentId}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** DELETE /api/cli/attachment/:id — --reason REQUIRED; blob hard-delete is irreversible. */
export async function runAttachmentDelete(client, attachmentId, flags) {
    return client.delete(`/api/cli/attachment/${attachmentId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
// ── Registration ─────────────────────────────────────────────────────────────
export function registerAttachmentCommands(parent, getClient) {
    const a = parent
        .command("attachment")
        .description("Attachments (files in Azure Blob) for any entity — list, download, upload, attach, detach");
    const listCmd = a
        .command("list")
        .description("List attachments linked to ONE entity (exactly one entity flag)")
        .option("--group <g>", "Filter by attachment group (name or id — see `ib attachment types`)")
        .option("--type <t>", "Filter by attachment type (name or id — see `ib attachment types`)")
        .option("--limit <n>", "Max rows (capped at 500)", (s) => Math.min(Number(s), 500));
    addEntityFlags(listCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const target = resolveEntityTarget(opts);
            const { groupId, typeId } = await resolveGroupAndType(client, {
                group: opts.group,
                type: opts.type,
            });
            writeJson(await runAttachmentList(client, target, { groupId, typeId, limit: opts.limit }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    a.command("get <attachmentId>")
        .description("One attachment: metadata, group/type names, 1h read-SAS blobUrl")
        .action(async (id) => {
        try {
            writeJson(await runAttachmentGet(await getClient(), Number(id)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    a.command("types")
        .description("Attachment groups + types legend (id + name; tenant-scoped reference data)")
        .action(async () => {
        try {
            writeJson(await runAttachmentTypes(await getClient()));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    a.command("search [text]")
        .description("Search attachments in the active company by file name/comment")
        .option("--missing", "Only attachments with NO linked entity (orphans)")
        .option("--limit <n>", "Max rows (capped at 500)", (s) => Math.min(Number(s), 500))
        .action(async (text, opts) => {
        try {
            if (!text && !opts.missing)
                failWith("Provide search text or --missing", 4);
            writeJson(await runAttachmentSearch(await getClient(), { q: text, missing: opts.missing, limit: opts.limit }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    a.command("download <attachmentId>")
        .description("Download the file to local disk (LOCAL ONLY — denied on remote exec/MCP)")
        .option("--out <path>", "Output path (default: original file name in cwd)")
        .option("--force", "Overwrite an existing file")
        .action(async (id, opts) => {
        try {
            writeJson(await runAttachmentDownload(await getClient(), Number(id), opts.out, !!opts.force));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const uploadCmd = a
        .command("upload <file>")
        .description("Upload a local file and link it to ONE entity (LOCAL ONLY — denied on remote exec/MCP)")
        .option("--comment <text>", "fileComment shown in the UI")
        .option("--group <g>", "Attachment group (name or id — see `ib attachment types`)")
        .option("--type <t>", "Attachment type (name or id — see `ib attachment types`)")
        .option("--mime <mime>", "Override the auto-detected MIME type");
    addEntityFlags(uploadCmd);
    addWriteFlagsToCommand(uploadCmd).action(async (file, opts) => {
        try {
            const client = await getClient();
            const { groupId, typeId } = await resolveGroupAndType(client, {
                group: opts.group,
                type: opts.type,
            });
            writeJson(await runAttachmentUpload(client, file, opts, {
                dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
                comment: opts.comment, mime: opts.mime,
                groupId, typeId,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    a.command("upload-url")
        .description("Mint a 1h write-SAS upload URL (remote-safe primitive; server picks the blob path)")
        .requiredOption("--name <fileName>", "Original file name WITH extension (server derives the blob name)")
        .action(async (opts) => {
        try {
            writeJson(await runAttachmentUploadUrl(await getClient(), opts.name));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const registerCmd = a
        .command("register")
        .description("Persist metadata AFTER PUTting bytes to an upload-url (remote-safe primitive)")
        .requiredOption("--name <fileName>", "fileName returned by upload-url")
        .requiredOption("--orig-name <name>", "Original file name")
        .requiredOption("--folder <fileFolder>", "fileFolder returned by upload-url")
        .requiredOption("--size <bytes>", "File size in bytes", (s) => Number(s))
        .requiredOption("--mime <mime>", "MIME type (fileType)")
        .option("--comment <text>", "fileComment")
        .option("--group <g>", "Attachment group (name or id)")
        .option("--type <t>", "Attachment type (name or id)")
        .option("--etag <etag>", "Azure ETag (optional; defaults to FE-parity sentinel)");
    addEntityFlags(registerCmd);
    addWriteFlagsToCommand(registerCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const target = resolveEntityTarget(opts);
            const { groupId, typeId } = await resolveGroupAndType(client, {
                group: opts.group,
                type: opts.type,
            });
            writeJson(await runAttachmentRegister(client, {
                fileName: opts.name, origFileName: opts.origName,
                fileFolder: opts.folder, fileType: opts.mime,
                fileSize: opts.size, entity: target.entity, entityId: target.entityId,
                fileComment: opts.comment,
                attachmentGroupId: groupId, attachmentTypeId: typeId,
                fileETag: opts.etag,
            }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const attachCmd = a
        .command("attach <attachmentId>")
        .description("Link an existing attachment to ONE entity (sets that FK; others untouched)");
    addEntityFlags(attachCmd);
    addWriteFlagsToCommand(attachCmd).action(async (id, opts) => {
        try {
            writeJson(await runAttachmentAttach(await getClient(), Number(id), opts, {
                dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const detachCmd = a
        .command("detach <attachmentId> <entity>")
        .description("Unlink an attachment from one entity (keikka|vehicle|person|customer|worksite|sijainti|tuote|bug-report|request|offer). Requires a manager role on the owner company.");
    addWriteFlagsToCommand(detachCmd).action(async (id, entity, opts) => {
        try {
            writeJson(await runAttachmentDetach(await getClient(), Number(id), entity, {
                dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = a
        .command("update <attachmentId>")
        .description("Update comment / group / type / invoice-flag (server read-merges unchanged fields)")
        .option("--comment <text>", "New fileComment")
        .option("--liita-laskuun <0|1>", "Invoice-attachment flag (lasku/asiakas admin only)", (s) => Number(s))
        .option("--group <g>", "Attachment group (name or id — see `ib attachment types`)")
        .option("--type <t>", "Attachment type (name or id — see `ib attachment types`)");
    addWriteFlagsToCommand(updateCmd).action(async (id, opts) => {
        try {
            const client = await getClient();
            const { groupId, typeId } = await resolveGroupAndType(client, {
                group: opts.group,
                type: opts.type,
            });
            writeJson(await runAttachmentUpdate(client, Number(id), {
                fileComment: opts.comment,
                liitaLaskuun: opts.liitaLaskuun,
                attachmentGroupId: groupId, attachmentTypeId: typeId,
            }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const deleteCmd = a
        .command("delete <attachmentId>")
        .description("Soft-delete the row AND hard-delete the Azure blob (IRREVERSIBLE). Requires --reason.");
    addWriteFlagsToCommand(deleteCmd).action(async (id, opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason (blob deletion is irreversible)", 4);
        }
        try {
            writeJson(await runAttachmentDelete(await getClient(), Number(id), {
                dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map