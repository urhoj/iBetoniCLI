import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, failWith, failUsage, warnNote } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { type AssessFlags, assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "../../assess.js";
import { addEditFlags, applyTextEdit, parseEditOp, textEditDryRunEnvelope, type TextEditOp } from "../../textEdit.js";

/**
 * `ib ohje` — read/write the **UI help-text content** stored in the `helps`
 * table (helpId → title/shorttext/htmltext/img). This is the end-user help that
 * a HelperIcon "(?)" button shows in a modal in the web app — deliberately
 * named `ohje` (Finnish for "guide/help") so it is NOT confused with
 * `ib --help`, which documents CLI usage.
 *
 * Backend surface (no `/api/cli/` wrapper — reuses the existing REST routes):
 *   GET  /api/helps/get/:helpId   → single entry (recordset)
 *   GET  /api/helps/getAll        → every entry
 *   PUT  /api/helps/update        → upsert one entry (gated to isHelperEditor)
 */

/** A single UI help-text entry (one `helps` row backing HelperIcon.jsx). */
export interface OhjeRecord {
  helpId: string;
  title?: string | null;
  shorttext?: string | null;
  htmltext?: string | null;
  img?: string | null;
  aiConfidence?: number | null;
  // BIT column: node-mssql yields a boolean, but tolerate a raw 0/1 too.
  needsHumanReview?: boolean | number | null;
  [key: string]: unknown;
}

/** Editable fields of a help entry (`helps_save` overwrites the whole row). */
export interface OhjeFields {
  title?: string;
  shorttext?: string;
  htmltext?: string;
  /** `null` clears the image column; `undefined` leaves it untouched. */
  img?: string | null;
}

/**
 * helpId validity: any non-empty string up to the `dbo.helps.helpId` column
 * width (nvarchar 250). The backend binds it as a parameter (no string-built
 * SQL), so no charset restriction is needed — real helpIds contain `:`, spaces,
 * commas, and Finnish letters (e.g. `tila:2`, `"XC3, XC4, XF1"`, `käyttöikä`).
 */
const HELP_ID_MAX = 250;
export function isValidHelpId(s: string): boolean {
  return typeof s === "string" && s.length > 0 && s.length <= HELP_ID_MAX;
}

/** Exit 4 on an invalid helpId — the guard every id-taking action shares. */
function assertValidHelpId(helpId: string): void {
  if (!isValidHelpId(helpId)) {
    failWith(`Invalid helpId "${helpId}" — must be 1–250 characters`, 4);
  }
}

/**
 * GET /api/helps/get/:helpId — the content shown in a HelperIcon modal. The
 * backend returns a recordset (array); we surface the first row, or `null` when
 * the helpId has no entry yet (the route returns an empty array, not a 404).
 */
export async function runOhjeGet(
  client: ApiClient,
  helpId: string
): Promise<OhjeRecord | null> {
  const rows = await client.get<OhjeRecord[]>(
    `/api/helps/get/${encodeURIComponent(helpId)}`
  );
  return Array.isArray(rows) ? rows[0] ?? null : (rows as OhjeRecord | null);
}

/** Client-side shaping for {@link runOhjeList} (the route has no query params). */
export interface OhjeListOptions {
  /** Cap rows AFTER filter+sort (preview a few without dumping every htmltext). */
  limit?: number;
  /** Keep only rows whose `shorttext` is blank — the grooming backfill targets. */
  emptyShorttext?: boolean;
  /**
   * Case-insensitive substring over helpId + title + shorttext (fb#607).
   *
   * `--search` is the reflex on a list command — it works on `glossary list`,
   * `feedback list`, `changelog list`, `schema procs` and `schema tables` — so
   * reaching for it here and getting exit 4 is a pure consistency failure.
   * Matches the same three human-readable columns a caller would eyeball;
   * `htmltext` is deliberately excluded, since a body-text hit would return the
   * row without showing why it matched.
   */
  search?: string;
  /** Project each row to just these columns (e.g. skip the large `htmltext`). */
  fields?: string[];
  /** `"field:dir"` (e.g. `accessCount:desc`); numeric fields compare numerically. */
  sort?: string;
  /** Keep only rows below the confidence threshold (or unassessed) AND not parked. */
  needsReview?: boolean;
  /** Threshold for {@link needsReview} (default 90). */
  maxConfidence?: number;
}

/**
 * GET /api/helps/getAll — every UI help entry, projected into the universal
 * list envelope so `--pretty` renders it as a table. The route accepts no query
 * params, so `--empty-shorttext` / `--fields` / `--sort` / `--limit` are applied
 * CLIENT-SIDE here. This is important for AI callers: the full table is ~115 KB
 * (191 rows × full htmltext), so `--empty-shorttext --fields helpId,title,accessCount`
 * is the cheap one-step fetch for grooming instead of dumping everything.
 * Order: filter → sort → limit → project.
 */
export async function runOhjeList(
  client: ApiClient,
  opts: OhjeListOptions = {}
): Promise<ListEnvelope<OhjeRecord>> {
  const rows = await client.get<OhjeRecord[]>("/api/helps/getAll");
  let all = Array.isArray(rows) ? rows : [];
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    all = all.filter((r) =>
      [r.helpId, r.title, r.shorttext].some((v) =>
        String(v ?? "").toLowerCase().includes(needle)
      )
    );
  }
  if (opts.emptyShorttext) {
    all = all.filter((r) => !String(r.shorttext ?? "").trim());
  }
  if (opts.needsReview) {
    const max = opts.maxConfidence ?? 90;
    all = all.filter((r) => {
      const c = r.aiConfidence;
      const below = c == null || (typeof c === "number" && c < max);
      const parked = r.needsHumanReview === true || r.needsHumanReview === 1;
      return below && !parked;
    });
    if (!opts.sort) opts = { ...opts, sort: "lastModifiedTime:asc" };
  }
  if (opts.sort) {
    const [field, dirRaw] = opts.sort.split(":");
    const desc = (dirRaw ?? "asc").toLowerCase() === "desc";
    all = [...all].sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      const c =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
      return desc ? -c : c;
    });
  }
  let items: OhjeRecord[] =
    opts.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;
  if (opts.fields && opts.fields.length) {
    items = items.map((r) => {
      const projected: Record<string, unknown> = {};
      for (const f of opts.fields!) projected[f] = r[f];
      return projected as OhjeRecord;
    });
  }
  return listEnvelope(items);
}

/**
 * Project commander options into {@link OhjeFields}: typed flags win over
 * `--body` JSON (mirrors `buildSijaintiBody`). `--img ""` is coerced to `null`
 * so an image can be CLEARED — otherwise `helps_save` would store an empty
 * string instead of NULL. Exported (pure) so the merge is unit-testable without
 * spawning the CLI.
 */
export function buildOhjeFields(opts: {
  body?: string;
  title?: string;
  shorttext?: string;
  htmltext?: string;
  img?: string;
}): OhjeFields {
  const parsed = opts.body ? (parseJsonBodyFlag(opts.body) as OhjeFields) : {};
  const img = opts.img ?? parsed.img;
  return {
    title: opts.title ?? parsed.title,
    shorttext: opts.shorttext ?? parsed.shorttext,
    htmltext: opts.htmltext ?? parsed.htmltext,
    img: img === "" ? null : img,
  };
}

/**
 * Merge the changed fields over the current row to form the full PUT body.
 * `helps_save` overwrites EVERY column, so a partial edit must carry the
 * existing values through or it would blank them — exactly what the HelperIcon
 * editor does (it posts full state). Only the five persisted columns are
 * emitted (helps_save reads just these), so extra GET columns
 * (rev/accessCount/timestamps) are NOT echoed back — keeping the `--dry-run`
 * `proposed` clean. An omitted field (`undefined`) falls back to the current
 * value, then to "" ; an explicit `null` img clears the column.
 */
export function buildOhjeBody(
  current: OhjeRecord | null,
  helpId: string,
  fields: OhjeFields
): OhjeRecord {
  const base: Partial<OhjeRecord> = current ?? {};
  return {
    helpId,
    title: fields.title ?? base.title ?? "",
    shorttext: fields.shorttext ?? base.shorttext ?? "",
    htmltext: fields.htmltext ?? base.htmltext ?? "",
    img: fields.img !== undefined ? fields.img : base.img ?? null,
  };
}

/**
 * Update one help entry (PUT /api/helps/update). The backend does NOT honour
 * X-Dry-Run on this route, so `--dry-run` is resolved CLIENT-SIDE: we GET the
 * current row, compute the merged proposed row, and return it WITHOUT writing —
 * a truthful preview instead of a silent persist. A real write GET-merges-PUTs
 * the full row (see buildOhjeBody) so untouched columns survive. Server-side
 * requires isHelperEditor (or system-admin/developer).
 */
export async function runOhjeUpdate(
  client: ApiClient,
  helpId: string,
  fields: OhjeFields,
  flags: WriteFlags,
  opts: { mustExist?: boolean } = {},
  assess: AssessFlags = {}
): Promise<unknown> {
  const current = await runOhjeGet(client, helpId);
  // The GET already tells us whether a row exists — surface it so callers can
  // detect an UNEXPECTED insert (a typo'd Finnish helpId silently creates a junk
  // row otherwise). `--must-exist` turns that into a hard failure instead.
  const created = current === null;
  if (opts.mustExist && created) {
    failWith(
      `helpId "${helpId}" has no existing row and --must-exist was set (refusing to create a new entry)`,
      4
    );
  }
  const proposed = buildOhjeBody(current, helpId, fields);
  // aiConfidence/needsHumanReview come ONLY from the flags — never from `current`.
  // buildOhjeBody emits just the 5 content columns, so an omitted --ai-confidence
  // leaves the key out of the body and the backend resets the stored score to NULL.
  const payload: Record<string, unknown> = { ...proposed };
  if (assess.aiConfidence !== undefined) payload.aiConfidence = assess.aiConfidence;
  if (assess.needsHumanReview) payload.needsHumanReview = true;
  if (flags.dryRun) {
    return { dryRun: true, helpId, created, current, proposed: payload };
  }
  const response = await client.put<unknown>("/api/helps/update", payload, {
    headers: writeFlagsToHeaders(flags),
  });
  // Echo what was written (the merged row) + a length so a parallel grooming
  // agent can spot a truncation/encoding issue without a separate `ohje get`.
  return {
    success: true,
    helpId,
    created,
    written: payload,
    htmltextLength: (proposed.htmltext ?? "").length,
    response,
  };
}

/** Text fields editable in-field (img is not text; helpId is the key). */
export const OHJE_EDITABLE_FIELDS = ["title", "shorttext", "htmltext"] as const;
export type OhjeEditableField = (typeof OHJE_EDITABLE_FIELDS)[number];

/**
 * Edit mode for `ohje update`: in-field partial edit of ONE text column. Fetches
 * the current row (exit 5 if the helpId has no row — you cannot edit a body that
 * does not exist), applies the edit, then `--dry-run` returns the field diff
 * without writing, or a real run delegates to `runOhjeUpdate` (which GET-merges
 * so the other columns survive).
 */
export async function runOhjeEditField(
  client: ApiClient,
  helpId: string,
  field: OhjeEditableField,
  op: TextEditOp,
  flags: WriteFlags,
  assess: AssessFlags = {}
): Promise<unknown> {
  const current = await runOhjeGet(client, helpId);
  if (current === null) {
    failWith(`helpId "${helpId}" has no existing row to edit — create it with a full --${field} first`, 5);
  }
  const before = String(current[field] ?? "");
  const { next, matchCount, seamInserted } = applyTextEdit(before, op);
  if (seamInserted) warnNote("[ib] a newline seam was inserted between the existing text and the new text (fb#790)");
  if (flags.dryRun) {
    return textEditDryRunEnvelope(before, next, matchCount, { helpId }, field, seamInserted);
  }
  return runOhjeUpdate(client, helpId, { [field]: next } as OhjeFields, flags, {}, assess);
}

/**
 * Delete one UI help entry (DELETE /api/helps/delete/:helpId). Used to remove
 * orphan (stale-named) or empty data-driven helpIds — a missing help row makes
 * its HelperIcon render nothing, the canonical graceful-absence behaviour.
 * `--dry-run` resolves CLIENT-SIDE: it GETs the current row and returns
 * `wouldDelete` (the row, or null when the helpId has no entry) WITHOUT issuing
 * the DELETE — safe even before the backend route deploys. A real run DELETEs
 * and reports whether a row existed (idempotent). Server-side requires
 * isHelperEditor (or system-admin/developer).
 */
export async function runOhjeDelete(
  client: ApiClient,
  helpId: string,
  flags: WriteFlags
): Promise<unknown> {
  const current = await runOhjeGet(client, helpId);
  if (flags.dryRun) {
    return { dryRun: true, helpId, wouldDelete: current };
  }
  const response = await client.delete<{ deleted?: boolean } | null>(
    `/api/helps/delete/${encodeURIComponent(helpId)}`,
    { headers: writeFlagsToHeaders(flags) }
  );
  return { success: true, helpId, deleted: response?.deleted ?? null };
}

/**
 * Register `ib ohje` subcommands on the parent commander instance:
 *   - get <helpId>     single help entry (GET /api/helps/get/:helpId)
 *   - list             every help entry, as a list envelope (GET /api/helps/getAll)
 *   - update <helpId>  GET-merge-PUT one entry; --reason required; --dry-run
 *                      previews the merged row client-side without writing
 *   - delete <helpId>  DELETE one entry; --reason required; --dry-run previews
 *                      the row that WOULD be deleted client-side without writing
 *
 * Exit codes: 4 = missing --reason / bad input; otherwise the contract-mapped
 * codes via exitWithError (2 auth · 3 permission · 4 validation · 5 not-found).
 */
export function registerOhjeCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const o = parent
    .command("ohje")
    .description(
      "UI help-text content (the helps table behind HelperIcon) — end-user help, NOT `ib --help`"
    );

  o.command("get <helpId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .action(guarded(async (helpId: string) => {
      assertValidHelpId(helpId);
      const client = await getClient();
      const result = await runOhjeGet(client, helpId);
      writeJson(result);
    }));

  addNeedsReviewFlags(
    o.command("list")
      .option("--limit <n>", "", (v: string) => Number(v))
      .option("--search <text>")
      .option("--empty-shorttext")
      .option(
        "--fields <cols>",
        "",
        (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean)
      )
      .option("--sort <field:dir>")
  )
    .action(
      jsonAction(getClient, (client, opts: { limit?: number; search?: string; emptyShorttext?: boolean; fields?: string[]; sort?: string; needsReview?: boolean; maxConfidence?: number; }) =>
        runOhjeList(client, opts)
      )
    );

  const updateCmd = o
    .command("update <helpId>")
    .option(
      "--body <json>"
    )
    .option("--title <s>")
    .option("--shorttext <s>")
    .option("--htmltext <s>")
    .option("--img <s>")
    .option(
      "--must-exist"
    )
    .option("--field <name>");
  addEditFlags(updateCmd);
  addWriteFlagsToCommand(addAssessWriteFlags(updateCmd)).action(
    guarded(async (
      helpId: string,
      opts: WriteFlags & {
        body?: string;
        title?: string;
        shorttext?: string;
        htmltext?: string;
        img?: string;
        mustExist?: boolean;
        aiConfidence?: number;
        needsHumanReview?: boolean;
        field?: string;
        replace?: string;
        with?: string;
        append?: string;
        prepend?: string;
        all?: boolean;
      }
    ) => {
      assertValidHelpId(helpId);
      const editOp = parseEditOp(opts);
      if (opts.field !== undefined && !editOp) {
        failUsage("--field only applies in edit mode (--replace / --append / --prepend)");
      }
      if (editOp) {
        if (
          opts.body !== undefined || opts.title !== undefined ||
          opts.shorttext !== undefined || opts.htmltext !== undefined ||
          opts.img !== undefined
        ) {
          failUsage("edit mode (--replace/--append/--prepend) cannot be combined with --body/--title/--shorttext/--htmltext/--img");
        }
        const rawField = opts.field ?? "htmltext";
        if (!(OHJE_EDITABLE_FIELDS as readonly string[]).includes(rawField)) {
          failUsage(`--field must be one of: ${OHJE_EDITABLE_FIELDS.join(", ")}`);
        }
        const field = rawField as OhjeEditableField;
        assertAiConfidence(opts.aiConfidence);
        const client = await getClient();
        writeJson(
          await runOhjeEditField(
            client, helpId, field, editOp, opts,
            { aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview }
          )
        );
        return;
      }
      assertAiConfidence(opts.aiConfidence);
      const client = await getClient();
      const fields = buildOhjeFields(opts);
      const result = await runOhjeUpdate(
        client,
        helpId,
        fields,
        opts,
        { mustExist: opts.mustExist },
        { aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview }
      );
      writeJson(result);
    })
  );

  const deleteCmd = o
    .command("delete <helpId>");
  addWriteFlagsToCommand(deleteCmd).action(
    guarded(async (helpId: string, opts: WriteFlags) => {
      assertValidHelpId(helpId);
      const client = await getClient();
      writeJson(await runOhjeDelete(client, helpId, opts));
    })
  );
}
