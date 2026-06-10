import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";

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
async function resolveGroupAndType(
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
  const parts: string[] = [];
  if (opts.q) parts.push(`q=${encodeURIComponent(opts.q)}`);
  if (opts.missing) parts.push("missing=1");
  if (opts.limit !== undefined) parts.push(`limit=${opts.limit}`);
  const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
  return client.get<ListEnvelope<Row>>(`/api/cli/attachment/search${qs}`);
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
    .description("Search attachments in the active company by file name/comment")
    .option("--missing", "Only attachments with NO linked entity (orphans)")
    .option("--limit <n>", "Max rows (capped at 500)", (s: string) => Math.min(Number(s), 500))
    .action(async (text: string | undefined, opts: { missing?: boolean; limit?: number }) => {
      try {
        if (!text && !opts.missing) failWith("Provide search text or --missing", 4);
        writeJson(await runAttachmentSearch(await getClient(), { q: text, missing: opts.missing, limit: opts.limit }));
      } catch (e) {
        exitWithError(e);
      }
    });

  // download / upload / upload-url / register / attach / detach / update / delete
  // are appended by Tasks 8–9 inside this same register function.
}

