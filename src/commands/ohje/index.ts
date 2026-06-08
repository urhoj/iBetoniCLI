import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";

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
  [key: string]: unknown;
}

/** Editable fields of a help entry (`helps_save` overwrites the whole row). */
export interface OhjeFields {
  title?: string;
  shorttext?: string;
  htmltext?: string;
  img?: string;
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

/**
 * GET /api/helps/getAll — every UI help entry, projected into the universal
 * list envelope so `--pretty` renders it as a table.
 */
export async function runOhjeList(
  client: ApiClient
): Promise<ListEnvelope<OhjeRecord>> {
  const rows = await client.get<OhjeRecord[]>("/api/helps/getAll");
  const items = Array.isArray(rows) ? rows : [];
  return { items, nextCursor: null, count: items.length };
}

/**
 * Merge the changed fields over the current row. `helps_save` overwrites EVERY
 * column, so a partial edit must carry the existing values through or it would
 * blank them — exactly what the HelperIcon editor does (it posts full state).
 * Typed field flags win; an omitted field falls back to the current value, then
 * to "" (img to null) when there is no current row (i.e. creating a new entry).
 */
export function buildOhjeBody(
  current: OhjeRecord | null,
  helpId: string,
  fields: OhjeFields
): OhjeRecord {
  const base: Partial<OhjeRecord> = current ?? {};
  return {
    ...base,
    helpId,
    title: fields.title ?? base.title ?? "",
    shorttext: fields.shorttext ?? base.shorttext ?? "",
    htmltext: fields.htmltext ?? base.htmltext ?? "",
    img: fields.img ?? base.img ?? null,
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
  flags: WriteFlags
): Promise<unknown> {
  const current = await runOhjeGet(client, helpId);
  const proposed = buildOhjeBody(current, helpId, fields);
  if (flags.dryRun) {
    return { dryRun: true, helpId, current, proposed };
  }
  return client.put<unknown>("/api/helps/update", proposed, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Register `ib ohje` subcommands on the parent commander instance:
 *   - get <helpId>     single help entry (GET /api/helps/get/:helpId)
 *   - list             every help entry, as a list envelope (GET /api/helps/getAll)
 *   - update <helpId>  GET-merge-PUT one entry; --reason required; --dry-run
 *                      previews the merged row client-side without writing
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
    .description("Get one UI help entry by helpId (GET /api/helps/get/:helpId)")
    .action(async (helpId: string) => {
      try {
        const client = await getClient();
        const result = await runOhjeGet(client, helpId);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  o.command("list")
    .description("List every UI help entry (GET /api/helps/getAll)")
    .action(async () => {
      try {
        const client = await getClient();
        const result = await runOhjeList(client);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  const updateCmd = o
    .command("update <helpId>")
    .description(
      "Update a UI help entry (PUT /api/helps/update). GET-merges the current row " +
        "so omitted fields are preserved (helps_save overwrites the whole row). " +
        "Provide typed flags or --body JSON (typed flags win). --reason is required. " +
        "--dry-run previews the merged row CLIENT-SIDE without writing (the backend " +
        "does not honour X-Dry-Run here). Requires isHelperEditor or system-admin/developer."
    )
    .option(
      "--body <json>",
      "JSON object with any of title/shorttext/htmltext/img (typed flags win)"
    )
    .option("--title <s>", "Help title (otsikko)")
    .option("--shorttext <s>", "Short text (shorttext)")
    .option("--htmltext <s>", "HTML body shown in the modal (htmltext)")
    .option("--img <s>", "Image reference (img)");
  addWriteFlagsToCommand(updateCmd).action(
    async (
      helpId: string,
      opts: {
        body?: string;
        title?: string;
        shorttext?: string;
        htmltext?: string;
        img?: string;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
      }
    ) => {
      // --reason is required for an actual write; a --dry-run preview is
      // read-only, so it does not need a justification.
      if (!opts.dryRun && !opts.reason) {
        writeError(new Error("Missing required flag: --reason"));
        process.exit(4);
      }
      try {
        const client = await getClient();
        const parsed = opts.body
          ? (JSON.parse(opts.body) as OhjeFields)
          : {};
        const fields: OhjeFields = {
          title: opts.title ?? parsed.title,
          shorttext: opts.shorttext ?? parsed.shorttext,
          htmltext: opts.htmltext ?? parsed.htmltext,
          img: opts.img ?? parsed.img,
        };
        const result = await runOhjeUpdate(client, helpId, fields, {
          dryRun: opts.dryRun,
          idempotencyKey: opts.idempotencyKey,
          reason: opts.reason,
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
