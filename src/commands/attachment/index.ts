import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { type WriteFlags, writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { CliError } from "../../api/errors.js";

type Row = Record<string, unknown>;

/** Wire entity names ↔ commander option keys. Mirrors backend ENTITY_COLUMNS. */
const ENTITY_OPTS: { optKey: string; flag: string; entity: string; blurb: string }[] = [
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
  { optKey: "message", flag: "--message <id>", entity: "message", blurb: "chat messageId (attach = message author)" },
];
const ENTITY_WORDS = ENTITY_OPTS.map((e) => e.entity);

function addEntityFlags(cmd: Command): Command {
  for (const e of ENTITY_OPTS) {
    cmd.option(e.flag, `Target = ${e.blurb}`, (s: string) => Number(s));
  }
  return cmd;
}

/** Exactly one entity flag must be set. Exported for tests. */
export function resolveEntityTarget(opts: Record<string, unknown>): {
  entity: string;
  entityId: number;
} {
  const hits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
  if (hits.length !== 1) {
    failWith(
      `Exactly one entity flag required (got ${hits.length}): ${ENTITY_OPTS.map((e) => e.flag.split(" ")[0]).join(" | ")}`,
      4
    );
  }
  const entityId = Number(opts[hits[0].optKey]);
  if (!Number.isInteger(entityId) || entityId <= 0) {
    failWith(`${hits[0].flag.split(" ")[0]} must be a positive integer`, 4);
  }
  return { entity: hits[0].entity, entityId };
}

/** Accepts "keikka" | "bug-report" | "bugReport" etc. for the detach positional. */
export function normalizeEntityWord(raw: string): string {
  const name = raw.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
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
export function resolveDetachEntity(
  positional: string | undefined,
  opts: Record<string, unknown>
): string {
  const flagHits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
  if (flagHits.length > 1) {
    failWith(
      `Only one entity flag allowed (got ${flagHits.length}): ${ENTITY_OPTS.map((e) => e.flag.split(" ")[0]).join(" | ")}`,
      4
    );
  }
  const fromFlag = flagHits.length === 1 ? flagHits[0].entity : undefined;
  const fromPositional = positional !== undefined ? normalizeEntityWord(positional) : undefined;
  if (fromFlag === undefined && fromPositional === undefined) {
    failWith(
      `Specify the entity to unlink as a positional word (e.g. 'keikka') or a flag (e.g. --keikka). Valid: ${ENTITY_WORDS.join(", ")}`,
      4
    );
  }
  if (fromFlag !== undefined && fromPositional !== undefined && fromFlag !== fromPositional) {
    failWith(`Conflicting entity: positional '${fromPositional}' vs flag '--${fromFlag}' — pass only one`, 4);
  }
  return (fromFlag ?? fromPositional) as string;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", heic: "image/heic", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip", json: "application/json",
};

/** Exported for tests. Fallback application/octet-stream; override with --mime. */
export function mimeFromExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Resolve --group/--type values that may be names ("tilaus") or ids ("1"). */
export async function resolveGroupAndType(
  client: ApiClient,
  opts: { group?: string; type?: string }
): Promise<{ groupId?: number; typeId?: number }> {
  let cached: { groups: Row[]; types: Row[] } | null = null;
  const load = async () => (cached ??= await runAttachmentTypes(client));
  const resolve = async (val: string | undefined, kind: "group" | "type") => {
    if (val === undefined) return undefined;
    if (/^\d+$/.test(val)) return Number(val);
    const data = await load();
    const list = kind === "group" ? data.groups : data.types;
    const nameKey = kind === "group" ? "attachmentGroupName" : "attachmentTypeName";
    const idKey = kind === "group" ? "attachmentGroupId" : "attachmentTypeId";
    const hit = list.find(
      (r) => String(r[nameKey]).toLowerCase() === val.toLowerCase()
    );
    if (!hit) {
      failWith(
        `Unknown ${kind} '${val}'. Valid: ${list.map((r) => `${r[idKey]}=${r[nameKey]}`).join(", ")}`,
        4
      );
    }
    return Number(hit![idKey]);
  };
  return { groupId: await resolve(opts.group, "group"), typeId: await resolve(opts.type, "type") };
}

// ── Pure run functions ───────────────────────────────────────────────────────

/** GET /api/cli/attachment/list — generic list-by-entity. */
export async function runAttachmentList(
  client: ApiClient,
  target: { entity: string; entityId: number },
  opts: { groupId?: number; typeId?: number; limit?: number }
): Promise<ListEnvelope<Row>> {
  const params = new URLSearchParams({ entity: target.entity, id: String(target.entityId) });
  if (opts.groupId !== undefined) params.set("group", String(opts.groupId));
  if (opts.typeId !== undefined) params.set("type", String(opts.typeId));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return client.get<ListEnvelope<Row>>(`/api/cli/attachment/list?${params.toString()}`);
}

/** GET /api/cli/attachment/get/:id — metadata + names + 1h blobUrl. */
export async function runAttachmentGet(client: ApiClient, attachmentId: number): Promise<Row> {
  return client.get<Row>(`/api/cli/attachment/get/${attachmentId}`);
}

/** GET /api/cli/attachment/types — groups + types legend (tenant from JWT). */
export async function runAttachmentTypes(
  client: ApiClient
): Promise<{ groups: Row[]; types: Row[] }> {
  return client.get<{ groups: Row[]; types: Row[] }>("/api/cli/attachment/types");
}

/** GET /api/cli/attachment/search — text search / orphaned (missing) listing. */
export async function runAttachmentSearch(
  client: ApiClient,
  opts: { q?: string; missing?: boolean; limit?: number }
): Promise<ListEnvelope<Row>> {
  // Manual encodeURIComponent (not URLSearchParams): the backend's qs parser
  // does NOT decode "+" to a space, so free-text q must use %20-encoding.
  const parts: string[] = [];
  if (opts.q) parts.push(`q=${encodeURIComponent(opts.q)}`);
  if (opts.missing) parts.push("missing=1");
  if (opts.limit !== undefined) parts.push(`limit=${opts.limit}`);
  const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
  return client.get<ListEnvelope<Row>>(`/api/cli/attachment/search${qs}`);
}

// ── Upload / download run functions ──────────────────────────────────────────

/** POST /api/cli/attachment/upload-url — authenticated SAS mint (server picks blob path). */
export async function runAttachmentUploadUrl(client: ApiClient, name: string): Promise<Row> {
  return client.post<Row>("/api/cli/attachment/upload-url", { name });
}

/** POST /api/cli/attachment/register — persist metadata after the bytes are in Azure. */
export async function runAttachmentRegister(
  client: ApiClient,
  body: {
    fileName: string; origFileName: string; fileFolder: string; fileType: string;
    fileSize: number; entity: string; entityId: number;
    fileComment?: string; attachmentGroupId?: number; attachmentTypeId?: number; fileETag?: string;
  },
  flags: WriteFlags
): Promise<Row> {
  return client.post<Row>("/api/cli/attachment/register", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * LOCAL upload convenience: readFile → upload-url → PUT to Azure → register.
 * --dry-run is CLIENT-side (validates the file, zero network calls).
 * DENIED on /api/cli/exec + MCP (server-side filesystem — LFI).
 */
export async function runAttachmentUpload(
  client: ApiClient,
  filePath: string,
  opts: Record<string, unknown>,
  flags: WriteFlags & { comment?: string; mime?: string; groupId?: number; typeId?: number }
): Promise<unknown> {
  const target = resolveEntityTarget(opts);
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
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
  const minted = (await runAttachmentUploadUrl(client, origFileName)) as {
    uploadUrl: string; fileFolder: string; fileName: string;
  };
  const putRes = await fetch(minted.uploadUrl, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob" },
    body: data,
  });
  if (!putRes.ok) {
    throw new CliError(`Azure blob upload failed: HTTP ${putRes.status}`, 0, null, 6);
  }
  return runAttachmentRegister(
    client,
    {
      fileName: minted.fileName, origFileName, fileFolder: minted.fileFolder,
      fileType, fileSize: data.length, entity: target.entity, entityId: target.entityId,
      fileComment: flags.comment, attachmentGroupId: flags.groupId, attachmentTypeId: flags.typeId,
    },
    { idempotencyKey: flags.idempotencyKey, reason: flags.reason }
  );
}

/**
 * LOCAL download: get → fetch blobUrl → writeFile. Refuses overwrite without force.
 * DENIED on /api/cli/exec + MCP (writes the server's disk) — remote callers fetch blobUrl themselves.
 */
export async function runAttachmentDownload(
  client: ApiClient,
  attachmentId: number,
  outPath: string | undefined,
  force: boolean
): Promise<Row> {
  const att = (await runAttachmentGet(client, attachmentId)) as {
    origFileName?: string; fileType?: string; blobUrl?: string;
  };
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
export async function runAttachmentAttach(
  client: ApiClient,
  attachmentId: number,
  opts: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  const target = resolveEntityTarget(opts);
  return client.post(
    "/api/cli/attachment/attach",
    { attachmentId, entity: target.entity, entityId: target.entityId },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/** POST /api/cli/attachment/detach — clear ONE entity FK. */
export async function runAttachmentDetach(
  client: ApiClient,
  attachmentId: number,
  entityWord: string,
  flags: WriteFlags
): Promise<unknown> {
  const entity = normalizeEntityWord(entityWord);
  return client.post(
    "/api/cli/attachment/detach",
    { attachmentId, entity },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/** PATCH /api/cli/attachment/:id — server read-merges; send only provided fields. */
export async function runAttachmentUpdate(
  client: ApiClient,
  attachmentId: number,
  fields: { fileComment?: string; liitaLaskuun?: number; attachmentGroupId?: number; attachmentTypeId?: number },
  flags: WriteFlags
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (fields.fileComment !== undefined) body.fileComment = fields.fileComment;
  if (fields.liitaLaskuun !== undefined) body.liitaLaskuun = fields.liitaLaskuun;
  if (fields.attachmentGroupId !== undefined) body.attachmentGroupId = fields.attachmentGroupId;
  if (fields.attachmentTypeId !== undefined) body.attachmentTypeId = fields.attachmentTypeId;
  return client.patch(`/api/cli/attachment/${attachmentId}`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** DELETE /api/cli/attachment/:id — --reason REQUIRED; blob hard-delete is irreversible. */
export async function runAttachmentDelete(
  client: ApiClient,
  attachmentId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete(`/api/cli/attachment/${attachmentId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerAttachmentCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const a = parent
    .command("attachment")
    .description("Attachments (files in Azure Blob) for any entity — list, download, upload, attach, detach");

  const listCmd = a
    .command("list")
    .description("List attachments linked to ONE entity (exactly one entity flag)")
    .option("--group <g>", "Filter by attachment group (name or id — see `ib attachment types`)")
    .option("--type <t>", "Filter by attachment type (name or id — see `ib attachment types`)")
    .option("--limit <n>", "Max rows (capped at 500)", (s: string) => Math.min(Number(s), 500));
  addEntityFlags(listCmd).action(async (opts: Record<string, unknown>) => {
    try {
      const client = await getClient();
      const target = resolveEntityTarget(opts);
      const { groupId, typeId } = await resolveGroupAndType(client, {
        group: opts.group as string | undefined,
        type: opts.type as string | undefined,
      });
      writeJson(await runAttachmentList(client, target, { groupId, typeId, limit: opts.limit as number | undefined }));
    } catch (e) {
      exitWithError(e);
    }
  });

  a.command("get <attachmentId>")
    .description("One attachment: metadata, group/type names, 1h read-SAS blobUrl")
    .action(async (id: string) => {
      try {
        writeJson(await runAttachmentGet(await getClient(), Number(id)));
      } catch (e) {
        exitWithError(e);
      }
    });

  a.command("types")
    .description("Attachment groups + types legend (id + name; tenant-scoped reference data)")
    .action(async () => {
      try {
        writeJson(await runAttachmentTypes(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  a.command("search [text]")
    .description("Search attachments in the active company by file name/comment; with no text and no --missing, lists ALL active company attachments (like `ib keikka list`)")
    .option("--missing", "Only attachments with NO linked entity (orphans)")
    .option("--limit <n>", "Max rows (capped at 500)", (s: string) => Math.min(Number(s), 500))
    .action(async (text: string | undefined, opts: { missing?: boolean; limit?: number }) => {
      try {
        writeJson(await runAttachmentSearch(await getClient(), { q: text, missing: opts.missing, limit: opts.limit }));
      } catch (e) {
        exitWithError(e);
      }
    });

  a.command("download <attachmentId>")
    .description("Download the file to local disk (LOCAL ONLY — denied on remote exec/MCP)")
    .option("--out <path>", "Output path (default: original file name in cwd)")
    .option("--force", "Overwrite an existing file")
    .action(async (id: string, opts: { out?: string; force?: boolean }) => {
      try {
        writeJson(await runAttachmentDownload(await getClient(), Number(id), opts.out, !!opts.force));
      } catch (e) {
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
  addWriteFlagsToCommand(uploadCmd).action(
    async (file: string, opts: WriteFlags & Record<string, unknown>) => {
      try {
        const client = await getClient();
        const { groupId, typeId } = await resolveGroupAndType(client, {
          group: opts.group as string | undefined,
          type: opts.type as string | undefined,
        });
        writeJson(
          await runAttachmentUpload(client, file, opts, {
            dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
            comment: opts.comment as string | undefined, mime: opts.mime as string | undefined,
            groupId, typeId,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  a.command("upload-url")
    .description("Mint a 1h write-SAS upload URL (remote-safe primitive; server picks the blob path)")
    .requiredOption("--name <fileName>", "Original file name WITH extension (server derives the blob name)")
    .action(async (opts: { name: string }) => {
      try {
        writeJson(await runAttachmentUploadUrl(await getClient(), opts.name));
      } catch (e) {
        exitWithError(e);
      }
    });

  const registerCmd = a
    .command("register")
    .description("Persist metadata AFTER PUTting bytes to an upload-url (remote-safe primitive)")
    .requiredOption("--name <fileName>", "fileName returned by upload-url")
    .requiredOption("--orig-name <name>", "Original file name")
    .requiredOption("--folder <fileFolder>", "fileFolder returned by upload-url")
    .requiredOption("--size <bytes>", "File size in bytes", (s: string) => Number(s))
    .requiredOption("--mime <mime>", "MIME type (fileType)")
    .option("--comment <text>", "fileComment")
    .option("--group <g>", "Attachment group (name or id)")
    .option("--type <t>", "Attachment type (name or id)")
    .option("--etag <etag>", "Azure ETag (optional; defaults to FE-parity sentinel)");
  addEntityFlags(registerCmd);
  addWriteFlagsToCommand(registerCmd).action(async (opts: WriteFlags & Record<string, unknown>) => {
    try {
      const client = await getClient();
      const target = resolveEntityTarget(opts);
      const { groupId, typeId } = await resolveGroupAndType(client, {
        group: opts.group as string | undefined,
        type: opts.type as string | undefined,
      });
      writeJson(
        await runAttachmentRegister(
          client,
          {
            fileName: opts.name as string, origFileName: opts.origName as string,
            fileFolder: opts.folder as string, fileType: opts.mime as string,
            fileSize: opts.size as number, entity: target.entity, entityId: target.entityId,
            fileComment: opts.comment as string | undefined,
            attachmentGroupId: groupId, attachmentTypeId: typeId,
            fileETag: opts.etag as string | undefined,
          },
          { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }
        )
      );
    } catch (e) {
      exitWithError(e);
    }
  });

  const attachCmd = a
    .command("attach <attachmentId>")
    .description("Link an existing attachment to ONE entity (sets that FK; others untouched)");
  addEntityFlags(attachCmd);
  addWriteFlagsToCommand(attachCmd).action(
    async (id: string, opts: WriteFlags & Record<string, unknown>) => {
      try {
        writeJson(await runAttachmentAttach(await getClient(), Number(id), opts, {
          dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
        }));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const detachCmd = a
    .command("detach <attachmentId> [entity]")
    .description("Unlink an attachment from one entity. Name the entity as a positional word OR an attach-style flag (--keikka 9001 — the id is ignored). Requires a manager role on the owner company.");
  addEntityFlags(detachCmd);
  addWriteFlagsToCommand(detachCmd).action(
    async (id: string, entity: string | undefined, opts: WriteFlags & Record<string, unknown>) => {
      try {
        const entityWord = resolveDetachEntity(entity, opts);
        writeJson(await runAttachmentDetach(await getClient(), Number(id), entityWord, {
          dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
        }));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const updateCmd = a
    .command("update <attachmentId>")
    .description("Update comment / group / type / invoice-flag (server read-merges unchanged fields)")
    .option("--comment <text>", "New fileComment")
    .option("--liita-laskuun <0|1>", "Invoice-attachment flag (lasku/asiakas admin only)", (s: string) => Number(s))
    .option("--group <g>", "Attachment group (name or id — see `ib attachment types`)")
    .option("--type <t>", "Attachment type (name or id — see `ib attachment types`)");
  addWriteFlagsToCommand(updateCmd).action(
    async (id: string, opts: WriteFlags & Record<string, unknown>) => {
      try {
        const client = await getClient();
        const { groupId, typeId } = await resolveGroupAndType(client, {
          group: opts.group as string | undefined,
          type: opts.type as string | undefined,
        });
        writeJson(await runAttachmentUpdate(client, Number(id), {
          fileComment: opts.comment as string | undefined,
          liitaLaskuun: opts.liitaLaskuun as number | undefined,
          attachmentGroupId: groupId, attachmentTypeId: typeId,
        }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const deleteCmd = a
    .command("delete <attachmentId>")
    .description("Soft-delete the row AND hard-delete the Azure blob (IRREVERSIBLE). Requires --reason.");
  addWriteFlagsToCommand(deleteCmd).action(async (id: string, opts: WriteFlags) => {
    if (!opts.reason) {
      failWith("Missing required flag: --reason (blob deletion is irreversible)", 4);
    }
    try {
      writeJson(await runAttachmentDelete(await getClient(), Number(id), {
        dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
      }));
    } catch (e) {
      exitWithError(e);
    }
  });
}

