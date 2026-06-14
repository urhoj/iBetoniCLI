import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import type { CommandSpec } from "../../../output/help.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../../output/json.js";
import { resolveDate } from "../../../dates.js";
import { resolveAsiakasTarget } from "../../customer/index.js";

type Row = Record<string, unknown>;

/**
 * The grid daily-message read endpoint returns three parallel datasets in one
 * object: the boxes themselves, the messages for the requested date, and the
 * per-role permission rows. The CLI surfaces that composite verbatim (minus the
 * transport-level `success` flag) — it is NOT a flat list, so it deliberately
 * does NOT use the list envelope.
 */
export interface DailyBoxesResult {
  boxes: Row[];
  messages: Row[];
  boxPermissions: Row[];
}

/**
 * Normalise a date flag to the backend's `YYYYMMDD` shape. Accepts
 * `today`/`yesterday`/`tomorrow` and `YYYY-MM-DD` (via {@link resolveDate}),
 * a bare `YYYYMMDD`, and the sentinel `00000000` (the undated "default" box).
 * Anything else exits 4 — the daily routes validate the same way server-side.
 */
export function toYyyymmdd(input: string): string {
  if (input === "00000000") return input;
  if (/^\d{8}$/.test(input)) return input;
  const iso = resolveDate(input); // today/yesterday/tomorrow or YYYY-MM-DD passthrough
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.replace(/-/g, "");
  failWith(`--date must be YYYYMMDD, YYYY-MM-DD, or today/yesterday/tomorrow (got "${input}")`, 4);
}

function stripSuccess(result: DailyBoxesResult & { success?: boolean }): DailyBoxesResult {
  return {
    boxes: result.boxes ?? [],
    messages: result.messages ?? [],
    boxPermissions: result.boxPermissions ?? [],
  };
}

// ─── reads ───────────────────────────────────────────────────────────────────

/**
 * GET /api/dailyMessage/box/list/:asiakasId — every daily-message box visible to
 * the caller for `asiakasId`, plus (when `yyyymmdd` is given) that date's message
 * text and the per-role permission rows. Returns the composite `{ boxes,
 * messages, boxPermissions }`.
 */
export async function runDailyList(
  client: ApiClient,
  asiakasId: number,
  yyyymmdd?: string
): Promise<DailyBoxesResult> {
  const qs = yyyymmdd ? `?yyyymmdd=${yyyymmdd}` : "";
  const result = await client.get<DailyBoxesResult & { success?: boolean }>(
    `/api/dailyMessage/box/list/${asiakasId}${qs}`
  );
  return stripSuccess(result);
}

/**
 * One box's full picture, resolved CLIENT-SIDE over {@link runDailyList} (there
 * is no per-box GET): the box row, its message for the date, and the permission
 * rows scoped to that box. Exits 5 when the box is not visible for `asiakasId`.
 */
export async function runDailyGet(
  client: ApiClient,
  asiakasId: number,
  boxId: number,
  yyyymmdd?: string
): Promise<{ box: Row; message: Row | null; permissions: Row[] }> {
  const all = await runDailyList(client, asiakasId, yyyymmdd);
  const box = all.boxes.find((b) => Number(b.boxId) === boxId);
  if (!box) {
    failWith(
      `No daily box ${boxId} visible for asiakasId ${asiakasId} — list with \`ib message daily list ${asiakasId}\``,
      5
    );
  }
  const message = all.messages.find((m) => Number(m.boxId) === boxId) ?? null;
  const permissions = all.boxPermissions.filter((p) => Number(p.boxId) === boxId);
  return { box, message, permissions };
}

// ─── writes ──────────────────────────────────────────────────────────────────

/**
 * POST /box/message/save — write (or clear) a box's message text for one date.
 * This is the core daily-message write; the backend also broadcasts a
 * `dailyMessage:updated` socket to every associated company. `message: null`
 * clears the day. Passing `--clear` and `--message` together is rejected upstream
 * (the action only sends one).
 *
 * `--dry-run` is CLIENT-SIDE: the dailyMessage routes have NO X-Dry-Run guard, so
 * a "dry-run" that POSTed would actually persist ([[feedback_ib_dryrun_deploy_gated]]).
 * We return the would-be payload and write NOTHING.
 */
export async function runDailySetMessage(
  client: ApiClient,
  body: { boxId: number; message: string | null; yyyymmdd: string },
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldSet: body };
  return client.post<unknown>("/api/dailyMessage/box/message/save", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * POST /box/save — rename a box / edit its lisätieto (box metadata, not content).
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailySaveBox(
  client: ApiClient,
  body: { boxId: number; boxTitle: string; boxLisatieto?: string | null },
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldSave: body };
  return client.post<unknown>("/api/dailyMessage/box/save", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Create a box. Two modes:
 *   default → POST /box/add/:yyyymmdd { ownerAsiakasId, boxTitle }
 *   --init  → POST /box/initialize { boxTitle } (the caller's OWN company's first
 *             box; server derives the company + checks permission)
 *
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailyAddBox(
  client: ApiClient,
  opts: { init: boolean; ownerAsiakasId?: number; yyyymmdd?: string; boxTitle?: string },
  flags: WriteFlags
): Promise<unknown> {
  const headers = writeFlagsToHeaders(flags);
  if (opts.init) {
    const body: Row = {};
    if (opts.boxTitle) body.boxTitle = opts.boxTitle;
    if (flags.dryRun) return { dryRun: true, wouldAdd: { path: "/api/dailyMessage/box/initialize", body } };
    return client.post<unknown>("/api/dailyMessage/box/initialize", body, { headers });
  }
  const yyyymmdd = opts.yyyymmdd ?? "00000000";
  const body: Row = { ownerAsiakasId: opts.ownerAsiakasId };
  if (opts.boxTitle) body.boxTitle = opts.boxTitle;
  const path = `/api/dailyMessage/box/add/${yyyymmdd}`;
  if (flags.dryRun) return { dryRun: true, wouldAdd: { path, body } };
  return client.post<unknown>(path, body, { headers });
}

/**
 * DELETE /box/delete/:boxId — remove a box (and its messages) for all companies.
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailyDeleteBox(
  client: ApiClient,
  boxId: number,
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldDelete: { boxId } };
  return client.delete<unknown>(`/api/dailyMessage/box/delete/${boxId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * POST /box/asiakas/add — share a box to another tenant (read-only by default).
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailyShare(
  client: ApiClient,
  body: { boxId: number; asiakasId: number },
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldShare: body };
  return client.post<unknown>("/api/dailyMessage/box/asiakas/add", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * DELETE /box/asiakas/delete/:id — stop sharing a box with a tenant.
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailyUnshare(
  client: ApiClient,
  dailyMessageBoxAsiakasId: number,
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldUnshare: { dailyMessageBoxAsiakasId } };
  return client.delete<unknown>(
    `/api/dailyMessage/box/asiakas/delete/${dailyMessageBoxAsiakasId}`,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /box/asiakas/permission/add — add a per-role ACL row for a shared box.
 * The endpoint does NOT set readOnly here (the row defaults read-only); adjust
 * read/edit afterwards with `perm-set`. `--dry-run` is client-side (see
 * {@link runDailySetMessage}).
 */
export async function runDailyGrant(
  client: ApiClient,
  body: {
    boxId: number;
    asiakasId: number;
    asiakasPersonSettingTypeId: number;
    dailyMessageBoxAsiakasId: number;
  },
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldGrant: body };
  return client.post<unknown>("/api/dailyMessage/box/asiakas/permission/add", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * DELETE /box/asiakas/permission/delete/:id — remove a per-role ACL row.
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailyRevoke(
  client: ApiClient,
  dailyMessageBoxAsiakasPermissionsId: number,
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldRevoke: { dailyMessageBoxAsiakasPermissionsId } };
  return client.delete<unknown>(
    `/api/dailyMessage/box/asiakas/permission/delete/${dailyMessageBoxAsiakasPermissionsId}`,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /box/asiakas/permission/save — set a permission row's role + read/edit access.
 * `--dry-run` is client-side (see {@link runDailySetMessage}).
 */
export async function runDailyPermSet(
  client: ApiClient,
  body: {
    dailyMessageBoxAsiakasPermissionsId: number;
    asiakasPersonSettingTypeId: number;
    readOnly: boolean;
  },
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldPermSet: body };
  return client.post<unknown>("/api/dailyMessage/box/asiakas/permission/save", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

// ─── registration ─────────────────────────────────────────────────────────────

/**
 * Register `ib message daily` — the grid daily-message whiteboard over
 * /api/dailyMessage/*. Date-keyed shared boxes (title + text), tenant-owned,
 * shareable to other tenants with a per-role read/write ACL.
 *
 *   list   [asiakas]          boxes (+ a date's messages + permissions)
 *   get    [asiakas] <boxId>  one box's row + message + permissions (client filter)
 *   set    <boxId> --message  write/clear a box's message for a date (core write)
 *   save   <boxId> --title    rename a box / edit lisätieto (metadata)
 *   add    [asiakas] | --init create a box (or the company's first via initialize)
 *   delete <boxId>            remove a box
 *   share  <boxId> --to       share to another tenant · unshare <id>
 *   grant  <boxId> …          add a per-role ACL row · revoke <id> · perm-set <id>
 *
 * All writes carry the universal --dry-run/--idempotency-key/--reason flags and
 * are blocked under --read-only. Daily-message --dry-run is resolved CLIENT-side
 * (returns the would-be payload, sends nothing) because the dailyMessage routes
 * have no server X-Dry-Run guard — a POSTed "dry-run" would persist.
 */
export function registerMessageDailyCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const d = parent
    .command("daily")
    .description("Grid daily-message boxes (date-keyed shared whiteboard with per-role ACL)");

  // reads ──────────────────────────────────────────────────────────────────────
  d.command("list [asiakasId]")
    .description("List a company's daily boxes (+ a date's messages + permissions)")
    .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)
    .option("--date <date>", "Date for messages: YYYYMMDD | YYYY-MM-DD | today/yesterday/tomorrow")
    .action(async (idStr: string | undefined, opts: { asiakas?: number; date?: string }) => {
      try {
        const asiakasId = resolveAsiakasTarget(idStr, opts.asiakas);
        const client = await getClient();
        writeJson(await runDailyList(client, asiakasId, opts.date ? toYyyymmdd(opts.date) : undefined));
      } catch (e) {
        exitWithError(e);
      }
    });

  d.command("get <boxId>")
    .description("One daily box: its row + message + permissions (resolved client-side)")
    .requiredOption("--asiakas <id>", "Company that the box is listed for (asiakasId)", Number)
    .option("--date <date>", "Date for the message: YYYYMMDD | YYYY-MM-DD | today")
    .action(async (boxIdStr: string, opts: { asiakas: number; date?: string }) => {
      try {
        const client = await getClient();
        writeJson(
          await runDailyGet(client, opts.asiakas, Number(boxIdStr), opts.date ? toYyyymmdd(opts.date) : undefined)
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  // content + metadata writes ───────────────────────────────────────────────────
  addWriteFlagsToCommand(
    d
      .command("set <boxId>")
      .description("Write or clear a box's message for a date (the core daily-message write)")
      .requiredOption("--date <date>", "Date the message applies to (YYYYMMDD | YYYY-MM-DD | today)")
      .option("--message <text>", "Message text to store")
      .option("--clear", "Clear the message for the date (mutually exclusive with --message)")
  ).action(
    async (
      boxIdStr: string,
      opts: { date: string; message?: string; clear?: boolean } & WriteFlags
    ) => {
      if (opts.clear && opts.message !== undefined) {
        failWith("Pass either --message or --clear, not both", 4);
      }
      if (!opts.clear && opts.message === undefined) {
        failWith("Provide --message <text> (or --clear to empty the day)", 4);
      }
      try {
        const client = await getClient();
        writeJson(
          await runDailySetMessage(
            client,
            { boxId: Number(boxIdStr), message: opts.clear ? null : opts.message ?? null, yyyymmdd: toYyyymmdd(opts.date) },
            opts
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    d
      .command("save <boxId>")
      .description("Rename a box / edit its lisätieto (box metadata, not message content)")
      .requiredOption("--title <text>", "New box title")
      .option("--lisatieto <text>", "Optional sub-text shown under the title")
  ).action(
    async (boxIdStr: string, opts: { title: string; lisatieto?: string } & WriteFlags) => {
      try {
        const client = await getClient();
        writeJson(
          await runDailySaveBox(
            client,
            { boxId: Number(boxIdStr), boxTitle: opts.title, boxLisatieto: opts.lisatieto ?? null },
            opts
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  // box lifecycle ────────────────────────────────────────────────────────────────
  addWriteFlagsToCommand(
    d
      .command("add [asiakasId]")
      .description("Create a daily box for a company (or --init the caller's own first box)")
      .option("--asiakas <id>", "Owner asiakasId (alias for the positional)", Number)
      .option("--date <date>", "Date the box is for (default 00000000 = undated default box)")
      .option("--title <text>", "Box title")
      .option("--init", "Use /box/initialize: the caller's OWN company's first box (no asiakasId)")
  ).action(
    async (
      idStr: string | undefined,
      opts: { asiakas?: number; date?: string; title?: string; init?: boolean } & WriteFlags
    ) => {
      try {
        const client = await getClient();
        let ownerAsiakasId: number | undefined;
        if (!opts.init) ownerAsiakasId = resolveAsiakasTarget(idStr, opts.asiakas);
        writeJson(
          await runDailyAddBox(
            client,
            {
              init: !!opts.init,
              ownerAsiakasId,
              yyyymmdd: opts.date ? toYyyymmdd(opts.date) : undefined,
              boxTitle: opts.title,
            },
            opts
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    d.command("delete <boxId>").description("Delete a daily box (and its messages) for all companies")
  ).action(async (boxIdStr: string, opts: WriteFlags) => {
    try {
      const client = await getClient();
      writeJson(await runDailyDeleteBox(client, Number(boxIdStr), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  // sharing + per-role ACL ─────────────────────────────────────────────────────
  addWriteFlagsToCommand(
    d
      .command("share <boxId>")
      .description("Share a box to another tenant (read-only until you grant + perm-set)")
      .requiredOption("--to <asiakasId>", "Tenant to share the box with", Number)
  ).action(async (boxIdStr: string, opts: { to: number } & WriteFlags) => {
    try {
      const client = await getClient();
      writeJson(await runDailyShare(client, { boxId: Number(boxIdStr), asiakasId: opts.to }, opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    d
      .command("unshare <dailyMessageBoxAsiakasId>")
      .description("Stop sharing a box with a tenant (by dailyMessageBoxAsiakasId)")
  ).action(async (idStr: string, opts: WriteFlags) => {
    try {
      const client = await getClient();
      writeJson(await runDailyUnshare(client, Number(idStr), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    d
      .command("grant <boxId>")
      .description("Add a per-role ACL row on a shared box (defaults read-only; set access via perm-set)")
      .requiredOption("--to <asiakasId>", "Tenant the role belongs to", Number)
      .requiredOption("--role <typeId>", "asiakasPersonSettingTypeId the rule applies to", Number)
      .requiredOption("--box-asiakas <id>", "dailyMessageBoxAsiakasId of the share row", Number)
  ).action(
    async (
      boxIdStr: string,
      opts: { to: number; role: number; boxAsiakas: number } & WriteFlags
    ) => {
      try {
        const client = await getClient();
        writeJson(
          await runDailyGrant(
            client,
            {
              boxId: Number(boxIdStr),
              asiakasId: opts.to,
              asiakasPersonSettingTypeId: opts.role,
              dailyMessageBoxAsiakasId: opts.boxAsiakas,
            },
            opts
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    d
      .command("revoke <dailyMessageBoxAsiakasPermissionsId>")
      .description("Remove a per-role ACL row (by dailyMessageBoxAsiakasPermissionsId)")
  ).action(async (idStr: string, opts: WriteFlags) => {
    try {
      const client = await getClient();
      writeJson(await runDailyRevoke(client, Number(idStr), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    d
      .command("perm-set <dailyMessageBoxAsiakasPermissionsId>")
      .description("Set a permission row's role + access (read|edit)")
      .requiredOption("--role <typeId>", "asiakasPersonSettingTypeId", Number)
      .requiredOption("--access <mode>", "read = read-only, edit = read/write")
  ).action(
    async (idStr: string, opts: { role: number; access: string } & WriteFlags) => {
      if (opts.access !== "read" && opts.access !== "edit") {
        failWith('--access must be "read" or "edit"', 4);
      }
      try {
        const client = await getClient();
        writeJson(
          await runDailyPermSet(
            client,
            {
              dailyMessageBoxAsiakasPermissionsId: Number(idStr),
              asiakasPersonSettingTypeId: opts.role,
              readOnly: opts.access === "read",
            },
            opts
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}

// ─── CommandSpecs (co-located: one source of truth for this sub-group). ───────
// Spread into COMMAND_SPECS in reference/specs.ts; `registerMessageDailyCommands`
// wires the matching leaves into the `ib message` umbrella in commands/message. ──

const DAILY_AUTH_ERRORS = [
  { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
  { http: 400, exit: 4, meaning: "Validation error (bad date/ids/missing fields)", remedy: "check the flags" },
  { http: 500, exit: 6, meaning: "Backend error", remedy: "retry with --verbose" },
];
const DAILY_BOX_ROW =
  "{ boxId, boxTitle, boxLisatieto?, ownerAsiakasId, dailyMessageBoxAsiakasId }";

export const MESSAGE_DAILY_SPECS: CommandSpec[] = [
  {
    command: "ib message daily list",
    description:
      "List a company's daily-message boxes; with --date, also that date's message text and the per-role permission rows. Returns the composite { boxes, messages, boxPermissions } (not a flat list).",
    auth: "any",
    args: [{ name: "asiakasId", type: "number", required: false, description: "Company to list boxes for (or --asiakas)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (alias for the positional)" },
      { name: "date", type: "date", description: "Date for messages: YYYYMMDD | YYYY-MM-DD | today/yesterday/tomorrow" },
    ],
    outputShape: `{ boxes: ${DAILY_BOX_ROW}[], messages: {...}[], boxPermissions: {...}[] }`,
    errors: DAILY_AUTH_ERRORS,
    notes: ["Boxes a company does not own are read-only for it (cross-tenant ownership rule)."],
    seeAlso: ["ib message daily get", "ib message daily set"],
    examples: ["ib message daily list 8 --date today", "ib message daily list --asiakas 8"],
  },
  {
    command: "ib message daily get",
    description: "One daily box's row + its message for the date + its permission rows, resolved client-side over the list (there is no per-box GET).",
    auth: "any",
    args: [{ name: "boxId", type: "number", description: "Box to fetch" }],
    flags: [
      { name: "asiakas", type: "number", required: true, description: "Company the box is listed for (asiakasId)" },
      { name: "date", type: "date", description: "Date for the message (YYYYMMDD | YYYY-MM-DD | today)" },
    ],
    outputShape: `{ box: ${DAILY_BOX_ROW}, message: {...}|null, permissions: {...}[] }`,
    errors: [{ http: 404, exit: 5, meaning: "Box not visible for the company", remedy: "ib message daily list <asiakasId>" }, ...DAILY_AUTH_ERRORS],
    examples: ["ib message daily get 36 --asiakas 8 --date today"],
  },
  {
    command: "ib message daily set",
    description: "Write or clear a box's message for a date — the core daily-message write. The backend also broadcasts a dailyMessage:updated socket to every associated company.",
    auth: "any",
    args: [{ name: "boxId", type: "number", description: "Box whose message to set" }],
    flags: [
      { name: "date", type: "date", required: true, description: "Date the message applies to" },
      { name: "message", type: "string", description: "Message text to store" },
      { name: "clear", type: "boolean", description: "Clear the message for the date (mutually exclusive with --message)" },
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, ... }",
    errors: DAILY_AUTH_ERRORS,
    notes: ["Exactly one of --message / --clear is required.", "--dry-run is CLIENT-side (returns the would-be payload, sends nothing) — the dailyMessage routes have no server X-Dry-Run guard."],
    seeAlso: ["ib message daily get"],
    examples: ['ib message daily set 36 --date today --message "Asema kiinni klo 15" --reason "tiedote"'],
  },
  {
    command: "ib message daily save",
    description: "Rename a box / edit its lisätieto (box metadata — distinct from `set`, which writes message content).",
    auth: "any",
    args: [{ name: "boxId", type: "number", description: "Box to rename" }],
    flags: [
      { name: "title", type: "string", required: true, description: "New box title" },
      { name: "lisatieto", type: "string", description: "Optional sub-text under the title" },
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, ... }",
    errors: DAILY_AUTH_ERRORS,
    examples: ['ib message daily save 36 --title "Pumpparitiedotteet"'],
  },
  {
    command: "ib message daily add",
    description: "Create a daily box for a company. With --init, calls /box/initialize for the caller's OWN company's first box (server derives the company + checks permission).",
    auth: "any",
    args: [{ name: "asiakasId", type: "number", required: false, description: "Owner company (omit with --init)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Owner asiakasId (alias for the positional)" },
      { name: "date", type: "date", description: "Date the box is for (default 00000000 = undated default box)" },
      { name: "title", type: "string", description: "Box title" },
      { name: "init", type: "boolean", description: "Caller's own company's first box via /box/initialize (no asiakasId)" },
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, boxId?, created? }",
    errors: DAILY_AUTH_ERRORS,
    seeAlso: ["ib message daily delete"],
    examples: ['ib message daily add 8 --title "Tiedotteet"', "ib message daily add --init"],
  },
  {
    command: "ib message daily delete",
    description: "Delete a daily box (and its messages) for all associated companies.",
    auth: "any",
    args: [{ name: "boxId", type: "number", description: "Box to delete" }],
    flags: [],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, ... }",
    errors: DAILY_AUTH_ERRORS,
    examples: ["ib message daily delete 36 --reason cleanup"],
  },
  {
    command: "ib message daily share",
    description: "Share a box to another tenant. The share starts read-only; add a per-role rule with `grant` then set access with `perm-set`.",
    auth: "any",
    args: [{ name: "boxId", type: "number", description: "Box to share" }],
    flags: [{ name: "to", type: "number", required: true, description: "Tenant (asiakasId) to share with" }],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, dailyMessageBoxAsiakasId? }",
    errors: DAILY_AUTH_ERRORS,
    seeAlso: ["ib message daily grant", "ib message daily unshare"],
    examples: ["ib message daily share 36 --to 26"],
  },
  {
    command: "ib message daily unshare",
    description: "Stop sharing a box with a tenant (by dailyMessageBoxAsiakasId).",
    auth: "any",
    args: [{ name: "dailyMessageBoxAsiakasId", type: "number", description: "Share row id" }],
    flags: [],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, ... }",
    errors: DAILY_AUTH_ERRORS,
    examples: ["ib message daily unshare 34"],
  },
  {
    command: "ib message daily grant",
    description: "Add a per-role ACL row on a shared box. The row defaults read-only — adjust read/edit afterwards with `perm-set`.",
    auth: "any",
    args: [{ name: "boxId", type: "number", description: "Box the rule applies to" }],
    flags: [
      { name: "to", type: "number", required: true, description: "Tenant (asiakasId) the role belongs to" },
      { name: "role", type: "number", required: true, description: "asiakasPersonSettingTypeId (e.g. 8=Pumppari, 2=Admin)" },
      { name: "box-asiakas", type: "number", required: true, description: "dailyMessageBoxAsiakasId of the share row" },
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, dailyMessageBoxAsiakasPermissionsId? }",
    errors: DAILY_AUTH_ERRORS,
    seeAlso: ["ib message daily perm-set", "ib message daily revoke"],
    examples: ["ib message daily grant 36 --to 8 --role 8 --box-asiakas 34"],
  },
  {
    command: "ib message daily revoke",
    description: "Remove a per-role ACL row (by dailyMessageBoxAsiakasPermissionsId).",
    auth: "any",
    args: [{ name: "dailyMessageBoxAsiakasPermissionsId", type: "number", description: "Permission row id" }],
    flags: [],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, ... }",
    errors: DAILY_AUTH_ERRORS,
    examples: ["ib message daily revoke 111"],
  },
  {
    command: "ib message daily perm-set",
    description: "Set a permission row's role + access (read = read-only, edit = read/write).",
    auth: "any",
    args: [{ name: "dailyMessageBoxAsiakasPermissionsId", type: "number", description: "Permission row id" }],
    flags: [
      { name: "role", type: "number", required: true, description: "asiakasPersonSettingTypeId" },
      { name: "access", type: "string", required: true, description: "read = read-only, edit = read/write" },
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ success, ... }",
    errors: DAILY_AUTH_ERRORS,
    examples: ["ib message daily perm-set 111 --role 8 --access edit"],
  },
];
