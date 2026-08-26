import { Option } from "commander";
import { writeJson, failWith } from "../../output/json.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { CliError } from "../../api/errors.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { assertPositiveInt, cappedInt, parseId } from "../../targets.js";
import { qs } from "../../api/query.js";
/** Wire entity names ↔ commander option keys. Mirrors backend ENTITY_COLUMNS. */
const ENTITY_OPTS = [
    { optKey: "keikka", flag: "--keikka <id>", entity: "keikka" },
    { optKey: "vehicle", flag: "--vehicle <id>", entity: "vehicle" },
    { optKey: "person", flag: "--person <id>", entity: "person" },
    { optKey: "customer", flag: "--customer <id>", entity: "customer" },
    { optKey: "worksite", flag: "--worksite <id>", entity: "worksite" },
    { optKey: "sijainti", flag: "--sijainti <id>", entity: "sijainti" },
    { optKey: "tuote", flag: "--tuote <id>", entity: "tuote" },
    { optKey: "bugReport", flag: "--bug-report <id>", entity: "bugReport" },
    { optKey: "request", flag: "--request <id>", entity: "request" },
    { optKey: "offer", flag: "--offer <id>", entity: "offer" },
    { optKey: "message", flag: "--message <id>", entity: "message" },
];
const ENTITY_WORDS = ENTITY_OPTS.map((e) => e.entity);
/** The `--flag` halves of {@link ENTITY_OPTS}, pre-joined for the two exactly/only-one error messages. */
const ENTITY_FLAG_LIST = ENTITY_OPTS.map((e) => e.flag.split(" ")[0]).join(" | ");
function addEntityFlags(cmd) {
    for (const e of ENTITY_OPTS) {
        cmd.option(e.flag, "", (s) => Number(s));
    }
    // Hidden alias (fb#429): the asiakasId flag is spelled `--asiakas` on most
    // tenant-scoped commands, but here the canonical spelling is `--customer`
    // (mirrors backend ENTITY_COLUMNS) — so the majority guess failed on every
    // attachment command. Hidden: the spec documents only `--customer`.
    cmd.addOption(new Option("--asiakas <id>").argParser((s) => Number(s)).hideHelp());
    return cmd;
}
/**
 * Fold the hidden `--asiakas` alias into `--customer` (fb#429). Commander has no
 * true option aliasing — `--asiakas` lands on its own `asiakas` key, which the
 * ENTITY_OPTS scans would read as ZERO entity flags. Both allowed only when they
 * agree, so a disagreement is a loud conflict rather than a silent pick.
 */
function foldAsiakasAlias(opts) {
    if (opts.asiakas === undefined)
        return;
    if (opts.customer !== undefined && opts.customer !== opts.asiakas) {
        failWith(`--asiakas is an alias for --customer — they disagree (${opts.asiakas} vs ${opts.customer}); pass only one`, 4);
    }
    opts.customer = opts.asiakas;
    delete opts.asiakas;
}
/** Exactly one entity flag must be set. Exported for tests. */
export function resolveEntityTarget(opts) {
    foldAsiakasAlias(opts);
    const hits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
    if (hits.length !== 1) {
        failWith(`Exactly one entity flag required (got ${hits.length}): ${ENTITY_FLAG_LIST}`, 4);
    }
    const entityId = Number(opts[hits[0].optKey]);
    assertPositiveInt(entityId, hits[0].flag.split(" ")[0]);
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
/**
 * Resolve the detach target entity from the optional positional word and/or the
 * attach-style entity flags. Detach NULLs the FK, so the flag's id is irrelevant
 * — only the entity NAME is used. Accepting `--keikka <id>` lets callers reuse
 * the exact `attach` syntax (`detach 4711 --keikka 9001`) instead of hitting a
 * usage error. Exactly one source required; both allowed only when they agree.
 * Exported for tests.
 */
export function resolveDetachEntity(positional, opts) {
    foldAsiakasAlias(opts);
    const flagHits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
    if (flagHits.length > 1) {
        failWith(`Only one entity flag allowed (got ${flagHits.length}): ${ENTITY_FLAG_LIST}`, 4);
    }
    const fromFlag = flagHits.length === 1 ? flagHits[0].entity : undefined;
    const fromPositional = positional !== undefined ? normalizeEntityWord(positional) : undefined;
    if (fromFlag === undefined && fromPositional === undefined) {
        failWith(`Specify the entity to unlink as a positional word (e.g. 'keikka') or a flag (e.g. --keikka). Valid: ${ENTITY_WORDS.join(", ")}`, 4);
    }
    if (fromFlag !== undefined && fromPositional !== undefined && fromFlag !== fromPositional) {
        failWith(`Conflicting entity: positional '${fromPositional}' vs flag '--${fromFlag}' — pass only one`, 4);
    }
    return (fromFlag ?? fromPositional);
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
    return client.get(`/api/cli/attachment/list${qs({
        entity: target.entity,
        id: target.entityId,
        group: opts.groupId,
        type: opts.typeId,
        limit: opts.limit,
    })}`);
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
    const suffix = parts.length > 0 ? `?${parts.join("&")}` : "";
    return client.get(`/api/cli/attachment/search${suffix}`);
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
        .option("--group <g>")
        .option("--type <t>")
        .option("--limit <n>", "", cappedInt(500));
    addEntityFlags(listCmd).action(guarded(async (opts) => {
        const client = await getClient();
        const target = resolveEntityTarget(opts);
        const { groupId, typeId } = await resolveGroupAndType(client, opts);
        writeJson(await runAttachmentList(client, target, { groupId, typeId, limit: opts.limit }));
    }));
    a.command("get <attachmentId>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .action(jsonAction(getClient, (client, id) => runAttachmentGet(client, parseId(id, "attachmentId"))));
    a.command("types")
        .action(jsonAction(getClient, runAttachmentTypes));
    a.command("search [text]")
        .option("--missing")
        .option("--limit <n>", "", cappedInt(500))
        .action(jsonAction(getClient, (client, text, opts) => runAttachmentSearch(client, { q: text, missing: opts.missing, limit: opts.limit })));
    a.command("download <attachmentId>")
        .option("--out <path>")
        .option("--force")
        .action(jsonAction(getClient, (client, id, opts) => runAttachmentDownload(client, parseId(id, "attachmentId"), opts.out, !!opts.force)));
    const uploadCmd = a
        .command("upload <file>")
        .option("--comment <text>")
        .option("--group <g>")
        .option("--type <t>")
        .option("--mime <mime>");
    addEntityFlags(uploadCmd);
    addWriteFlagsToCommand(uploadCmd).action(guarded(async (file, opts) => {
        const client = await getClient();
        const { groupId, typeId } = await resolveGroupAndType(client, opts);
        writeJson(await runAttachmentUpload(client, file, opts, {
            dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
            comment: opts.comment, mime: opts.mime,
            groupId, typeId,
        }));
    }));
    a.command("upload-url")
        .requiredOption("--name <fileName>")
        .action(jsonAction(getClient, (client, opts) => runAttachmentUploadUrl(client, opts.name)));
    const registerCmd = a
        .command("register")
        .requiredOption("--name <fileName>")
        .requiredOption("--orig-name <name>")
        .requiredOption("--folder <fileFolder>")
        .requiredOption("--size <bytes>", "", (s) => Number(s))
        .requiredOption("--mime <mime>")
        .option("--comment <text>")
        .option("--group <g>")
        .option("--type <t>")
        .option("--etag <etag>");
    addEntityFlags(registerCmd);
    addWriteFlagsToCommand(registerCmd).action(guarded(async (opts) => {
        const client = await getClient();
        const target = resolveEntityTarget(opts);
        const { groupId, typeId } = await resolveGroupAndType(client, opts);
        writeJson(await runAttachmentRegister(client, {
            fileName: opts.name, origFileName: opts.origName,
            fileFolder: opts.folder, fileType: opts.mime,
            fileSize: opts.size, entity: target.entity, entityId: target.entityId,
            fileComment: opts.comment,
            attachmentGroupId: groupId, attachmentTypeId: typeId,
            fileETag: opts.etag,
        }, opts));
    }));
    const attachCmd = a
        .command("attach <attachmentId>");
    addEntityFlags(attachCmd);
    addWriteFlagsToCommand(attachCmd).action(jsonAction(getClient, (client, id, opts) => runAttachmentAttach(client, parseId(id, "attachmentId"), opts, opts)));
    const detachCmd = a
        .command("detach <attachmentId> [entity]");
    addEntityFlags(detachCmd);
    addWriteFlagsToCommand(detachCmd).action(guarded(async (id, entity, opts) => {
        const entityWord = resolveDetachEntity(entity, opts);
        writeJson(await runAttachmentDetach(await getClient(), parseId(id, "attachmentId"), entityWord, opts));
    }));
    const updateCmd = a
        .command("update <attachmentId>")
        .option("--comment <text>")
        .option("--liita-laskuun <0|1>", "", (s) => Number(s))
        .option("--group <g>")
        .option("--type <t>");
    addWriteFlagsToCommand(updateCmd).action(guarded(async (id, opts) => {
        const client = await getClient();
        // parseId BEFORE resolveGroupAndType (fb#909): a bad id must fail locally
        // even when --group/--type are NAMES (that branch fetches /types first).
        const attachmentId = parseId(id, "attachmentId");
        const { groupId, typeId } = await resolveGroupAndType(client, opts);
        writeJson(await runAttachmentUpdate(client, attachmentId, {
            fileComment: opts.comment,
            liitaLaskuun: opts.liitaLaskuun,
            attachmentGroupId: groupId, attachmentTypeId: typeId,
        }, opts));
    }));
    const deleteCmd = a
        .command("delete <attachmentId>");
    addWriteFlagsToCommand(deleteCmd).action(guarded(async (id, opts) => {
        writeJson(await runAttachmentDelete(await getClient(), parseId(id, "attachmentId"), opts));
    }));
}
//# sourceMappingURL=index.js.map