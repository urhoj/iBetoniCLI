import { Option, type Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith } from "../../output/json.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { type WriteFlags, writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { CliError } from "../../api/errors.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { assertPositiveInt, cappedInt, intFlag, parseId, zeroOneFlag } from "../../targets.js";
import { qs } from "../../api/query.js";

type Row = Record<string, unknown>;

/** Wire entity names ↔ commander option keys. Mirrors backend ENTITY_COLUMNS. */
const ENTITY_OPTS: { optKey: string; flag: string; entity: string }[] = [
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

/**
 * Base options of any attachment command that targets an entity: the universal
 * write flags plus the `--<entity> <id>` flags generated from
 * {@link ENTITY_OPTS}. Those keys are table-driven, so they cannot be spelled
 * out — hence the index signature, which is also what lets these option objects
 * be handed to `resolveEntityTarget` / `resolveDetachEntity`. Each command's own
 * named flags are declared on top of this and are properly typed, so reading
 * them needs no cast.
 */
type AttachmentEntityOpts = WriteFlags & { [entityFlag: string]: unknown };

/** Flags shared by every command that accepts `--group` / `--type` by name or id. */
type GroupTypeOpts = { group?: string; type?: string };

type AttachmentListOpts = AttachmentEntityOpts & GroupTypeOpts & { limit?: number };

type AttachmentUploadOpts = AttachmentEntityOpts &
  GroupTypeOpts & { comment?: string; mime?: string };

type AttachmentRegisterOpts = AttachmentEntityOpts &
  GroupTypeOpts & {
    name: string;
    origName: string;
    folder: string;
    size: number;
    mime: string;
    comment?: string;
    etag?: string;
  };

type AttachmentUpdateOpts = WriteFlags &
  GroupTypeOpts & { comment?: string; liitaLaskuun?: number };

function addEntityFlags(cmd: Command): Command {
  for (const e of ENTITY_OPTS) {
    cmd.option(e.flag, "", intFlag(e.flag.split(" ")[0]));
  }
  // Hidden alias (fb#429): the asiakasId flag is spelled `--asiakas` on most
  // tenant-scoped commands, but here the canonical spelling is `--customer`
  // (mirrors backend ENTITY_COLUMNS) — so the majority guess failed on every
  // attachment command. Hidden: the spec documents only `--customer`.
  cmd.addOption(new Option("--asiakas <id>").argParser(intFlag("--asiakas")).hideHelp());
  return cmd;
}

/**
 * Fold the hidden `--asiakas` alias into `--customer` (fb#429). Commander has no
 * true option aliasing — `--asiakas` lands on its own `asiakas` key, which the
 * ENTITY_OPTS scans would read as ZERO entity flags. Both allowed only when they
 * agree, so a disagreement is a loud conflict rather than a silent pick.
 */
function foldAsiakasAlias(opts: Record<string, unknown>): void {
  if (opts.asiakas === undefined) return;
  if (opts.customer !== undefined && opts.customer !== opts.asiakas) {
    failWith(
      `--asiakas is an alias for --customer — they disagree (${opts.asiakas} vs ${opts.customer}); pass only one`,
      4
    );
  }
  opts.customer = opts.asiakas;
  delete opts.asiakas;
}

/** Exactly one entity flag must be set. Exported for tests. */
export function resolveEntityTarget(opts: Record<string, unknown>): {
  entity: string;
  entityId: number;
} {
  foldAsiakasAlias(opts);
  const hits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
  if (hits.length !== 1) {
    failWith(
      `Exactly one entity flag required (got ${hits.length}): ${ENTITY_FLAG_LIST}`,
      4
    );
  }
  const entityId = Number(opts[hits[0].optKey]);
  assertPositiveInt(entityId, hits[0].flag.split(" ")[0]);
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
  foldAsiakasAlias(opts);
  const flagHits = ENTITY_OPTS.filter((e) => opts[e.optKey] !== undefined);
  if (flagHits.length > 1) {
    failWith(
      `Only one entity flag allowed (got ${flagHits.length}): ${ENTITY_FLAG_LIST}`,
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
  return client.get<ListEnvelope<Row>>(
    `/api/cli/attachment/list${qs({
      entity: target.entity,
      id: target.entityId,
      group: opts.groupId,
      type: opts.typeId,
      limit: opts.limit,
    })}`
  );
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
  const suffix = parts.length > 0 ? `?${parts.join("&")}` : "";
  return client.get<ListEnvelope<Row>>(`/api/cli/attachment/search${suffix}`);
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
    .option("--group <g>")
    .option("--type <t>")
    .option("--limit <n>", "", cappedInt(500));
  addEntityFlags(listCmd).action(guarded(async (opts: AttachmentListOpts) => {
    const client = await getClient();
    const target = resolveEntityTarget(opts);
    const { groupId, typeId } = await resolveGroupAndType(client, opts);
    writeJson(await runAttachmentList(client, target, { groupId, typeId, limit: opts.limit }));
  }));

  a.command("get <attachmentId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .action(jsonAction(getClient, (client, id: string) => runAttachmentGet(client, parseId(id, "attachmentId"))));

  a.command("types")
    .action(jsonAction(getClient, runAttachmentTypes));

  a.command("search [text]")
    .option("--missing")
    .option("--limit <n>", "", cappedInt(500))
    .action(
      jsonAction(getClient, (client, text: string | undefined, opts: { missing?: boolean; limit?: number }) =>
        runAttachmentSearch(client, { q: text, missing: opts.missing, limit: opts.limit })
      )
    );

  a.command("download <attachmentId>")
    .option("--out <path>")
    .option("--force")
    .action(
      jsonAction(getClient, (client, id: string, opts: { out?: string; force?: boolean }) =>
        runAttachmentDownload(client, parseId(id, "attachmentId"), opts.out, !!opts.force)
      )
    );

  const uploadCmd = a
    .command("upload <file>")
    .option("--comment <text>")
    .option("--group <g>")
    .option("--type <t>")
    .option("--mime <mime>");
  addEntityFlags(uploadCmd);
  addWriteFlagsToCommand(uploadCmd).action(
    guarded(async (file: string, opts: AttachmentUploadOpts) => {
      const client = await getClient();
      const { groupId, typeId } = await resolveGroupAndType(client, opts);
      writeJson(
        await runAttachmentUpload(client, file, opts, {
          dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
          comment: opts.comment, mime: opts.mime,
          groupId, typeId,
        })
      );
    })
  );

  a.command("upload-url")
    .requiredOption("--name <fileName>")
    .action(
      jsonAction(getClient, (client, opts: { name: string }) =>
        runAttachmentUploadUrl(client, opts.name)
      )
    );

  const registerCmd = a
    .command("register")
    .requiredOption("--name <fileName>")
    .requiredOption("--orig-name <name>")
    .requiredOption("--folder <fileFolder>")
    .requiredOption("--size <bytes>", "", intFlag("--size", 0))
    .requiredOption("--mime <mime>")
    .option("--comment <text>")
    .option("--group <g>")
    .option("--type <t>")
    .option("--etag <etag>");
  addEntityFlags(registerCmd);
  addWriteFlagsToCommand(registerCmd).action(guarded(async (opts: AttachmentRegisterOpts) => {
    const client = await getClient();
    const target = resolveEntityTarget(opts);
    const { groupId, typeId } = await resolveGroupAndType(client, opts);
    writeJson(
      await runAttachmentRegister(
        client,
        {
          fileName: opts.name, origFileName: opts.origName,
          fileFolder: opts.folder, fileType: opts.mime,
          fileSize: opts.size, entity: target.entity, entityId: target.entityId,
          fileComment: opts.comment,
          attachmentGroupId: groupId, attachmentTypeId: typeId,
          fileETag: opts.etag,
        },
        opts
      )
    );
  }));

  const attachCmd = a
    .command("attach <attachmentId>");
  addEntityFlags(attachCmd);
  addWriteFlagsToCommand(attachCmd).action(
    jsonAction(getClient, (client, id: string, opts: AttachmentEntityOpts) =>
      runAttachmentAttach(client, parseId(id, "attachmentId"), opts, opts)
    )
  );

  const detachCmd = a
    .command("detach <attachmentId> [entity]");
  addEntityFlags(detachCmd);
  addWriteFlagsToCommand(detachCmd).action(
    guarded(async (id: string, entity: string | undefined, opts: AttachmentEntityOpts) => {
      const entityWord = resolveDetachEntity(entity, opts);
      writeJson(await runAttachmentDetach(await getClient(), parseId(id, "attachmentId"), entityWord, opts));
    })
  );

  const updateCmd = a
    .command("update <attachmentId>")
    .option("--comment <text>")
    .option("--liita-laskuun <0|1>", "", zeroOneFlag("--liita-laskuun"))
    .option("--group <g>")
    .option("--type <t>");
  addWriteFlagsToCommand(updateCmd).action(
    guarded(async (id: string, opts: AttachmentUpdateOpts) => {
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
    })
  );

  const deleteCmd = a
    .command("delete <attachmentId>");
  addWriteFlagsToCommand(deleteCmd).action(guarded(async (id: string, opts: WriteFlags) => {
    writeJson(await runAttachmentDelete(await getClient(), parseId(id, "attachmentId"), opts));
  }));
}

