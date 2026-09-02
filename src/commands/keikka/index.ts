import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { addJsonBodyOptions, resolveJsonBody, type JsonBodyFlags } from "../_shared/jsonBody.js";
import { resolveDate, todayHelsinki, addDaysISO } from "../../dates.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { registerLogAlias } from "../log/index.js";
import { parseId, resolveSearchQuery, resolveTarget, cappedInt, queryAliasOption, intFlag } from "../../targets.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";

export interface KeikkaListFilter {
  from?: string;
  to?: string;
  customer?: number;
  vehicle?: number;
  status?: string;
  worksite?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Build the count:0 disambiguation hint (feedback #165). An AI seeing an empty
 * list can't tell "no access" from "no data" from "date-filtered"; this spells
 * it out: 0 rows on a 200/exit-0 is a PERMITTED-but-empty result (access denial
 * is exit 3 / HTTP 403), names the searched window, flags the today-only default,
 * and points at the two ways to see more (widen --from/--to, or `ib keikka latest`
 * for the most recent match within its own --lookback window, default 365 days).
 */
function zeroRowHint(
  range: { from: string | null; to: string | null },
  opts: KeikkaListFilter
): string {
  const window =
    range.from && range.to
      ? range.from === range.to
        ? range.from
        : `${range.from}..${range.to}`
      : "the requested window";
  const today = todayHelsinki();
  const scopedToToday = range.from === today && range.to === today;
  const hasFilters =
    opts.customer !== undefined ||
    opts.vehicle !== undefined ||
    opts.worksite !== undefined ||
    opts.status !== undefined;
  return (
    `0 rows: no keikka in ${window}${hasFilters ? " matching the given filters" : ""}. ` +
    `A 0 count on a successful (exit 0) query means no data in this window, NOT an access error ` +
    `(denied access surfaces as exit 3 / HTTP 403). ` +
    (scopedToToday ? "The default window is TODAY only. " : "") +
    "Widen the range with --from/--to, or run `ib keikka latest` to fetch the most recent " +
    "keikka within the last 365 days (its --lookback default; raise --lookback for an older one)."
  );
}

/**
 * GET /api/cli/keikka/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runKeikkaList(
  client: ApiClient,
  opts: KeikkaListFilter
): Promise<
  ListEnvelope<Record<string, unknown>> & {
    range: { from: string | null; to: string | null };
    hint?: string;
  }
> {
  const envelope = await client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/keikka/list${qs({
      from: opts.from || undefined,
      to: opts.to || undefined,
      customer: opts.customer,
      vehicle: opts.vehicle,
      worksite: opts.worksite,
      status: opts.status || undefined,
      limit: opts.limit,
      cursor: opts.cursor || undefined,
    })}`
  );
  // Echo the interpreted date window so a count:0 result is self-evidently
  // scoped — without it an empty list is indistinguishable from a mis-aimed query.
  const range = { from: opts.from ?? null, to: opts.to ?? null };
  // On an empty result add the "why zero rows" hint so an AI reader doesn't
  // mistake permitted-but-empty for an access block (feedback #165).
  return envelope.count === 0
    ? { ...envelope, range, hint: zeroRowHint(range, opts) }
    : { ...envelope, range };
}

/** Filters for `ib keikka latest` (a date-less "most recent matching" query). */
export interface KeikkaLatestFilter {
  status?: string;
  customer?: number;
  vehicle?: number;
  worksite?: number;
  /** How far back from today to search, in days. Default 365, capped at 3650. */
  lookback?: number;
}

/** Result of `runKeikkaLatest`: the newest matching row (or null) + the searched window. */
export interface KeikkaLatestResult {
  item: Record<string, unknown> | null;
  searched: { from: string; to: string };
}

/** Window sizes (days) walked backwards from today; the last size repeats until --lookback is covered. */
const LATEST_WINDOW_DAYS = [7, 30, 90, 365];

/** Whole days between two ISO dates (a ≤ b). */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  );
}

/** Newest row first: order by pvm, then time (ISO strings compare lexically). */
function newestFirst(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return (
    String(b.pvm ?? "").localeCompare(String(a.pvm ?? "")) ||
    String(b.time ?? "").localeCompare(String(a.time ?? ""))
  );
}

/**
 * "Latest keikka matching the filters" WITHOUT a mandatory date range
 * (feedback #26: one-step answers to "when was the last delivered order?").
 *
 * Entirely client-side over the existing `/api/cli/keikka/list` window query —
 * no backend change, no deploy gate. Walks contiguous windows backwards from
 * today (7 → 30 → 90 → 365-day spans, the last repeating) until a window has
 * matches or `--lookback` (default 365 days) is exhausted; the newest row of
 * the first non-empty window is the answer. Worst case = a handful of
 * round-trips. When a window comes back truncated at the 500-row server cap
 * (order not guaranteed), it is repeatedly halved toward its NEWEST end so
 * the true latest row cannot be hidden by truncation.
 */
export async function runKeikkaLatest(
  client: ApiClient,
  opts: KeikkaLatestFilter
): Promise<KeikkaLatestResult> {
  const today = todayHelsinki();
  const lookback = Math.min(Math.max(opts.lookback ?? 365, 1), 3650);
  const earliest = addDaysISO(today, -(lookback - 1));
  const base = {
    status: opts.status,
    customer: opts.customer,
    vehicle: opts.vehicle,
    worksite: opts.worksite,
    limit: 500,
  };

  let to = today;
  let windowIdx = 0;
  while (to >= earliest) {
    const span = LATEST_WINDOW_DAYS[Math.min(windowIdx, LATEST_WINDOW_DAYS.length - 1)];
    windowIdx++;
    let from = addDaysISO(to, -(span - 1));
    if (from < earliest) from = earliest;

    let env = await runKeikkaList(client, { ...base, from, to });
    // Truncated at the server cap → halve toward the newest end until the
    // window fits (or is a single day, which we accept as-is).
    while (env.count >= 500 && from < to) {
      from = addDaysISO(to, -Math.floor(daysBetween(from, to) / 2));
      env = await runKeikkaList(client, { ...base, from, to });
    }
    if (env.count > 0) {
      const newest = [...env.items].sort(newestFirst)[0];
      return { item: newest, searched: { from, to: today } };
    }
    to = addDaysISO(from, -1);
  }
  return { item: null, searched: { from: earliest, to: today } };
}

/**
 * GET /api/cli/keikka/get/:keikkaId. Passes the backend record through as-is —
 * the route already projects the related sub-objects server-side
 * (customer/worksite/vehicle/driver, each `{...} | null`), so no client-side
 * reshaping happens here (fb#246: the spec's nested outputShape IS the wire shape).
 */
export async function runKeikkaGet(
  client: ApiClient,
  keikkaId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/keikka/get/${keikkaId}`
  );
}

/** A projected keikka search hit (deduped; the backend returns one row per betoni pour). */
export interface KeikkaSearchHit {
  keikkaId: number;
  title: string | null;
  pumppuAika: string | null;
  customerName: string | null;
  worksiteName: string | null;
  address: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
}

/**
 * GET /api/keikka/search — existing deployed route (used by the GPT order
 * tool). NOTE: ownerAsiakasId comes from the QUERY STRING (no JWT fallback on
 * this route) — callers supply it from the active token via decodeJwtPayload.
 * usingFullTextSearch=true mirrors the GPT tool's default path. Rows arrive
 * one-per-keikkaBetoni; dedupe by keikkaId. `limit` is applied client-side
 * (the backend caps at TOP 100, no limit param).
 */
export async function runKeikkaSearch(
  client: ApiClient,
  query: string,
  ownerAsiakasId: number,
  limit?: number
): Promise<ListEnvelope<KeikkaSearchHit>> {
  const rows = await client.get<Record<string, unknown>[]>(
    `/api/keikka/search${qs({
      searchString: query,
      ownerAsiakasId,
      usingFullTextSearch: "true",
    })}`
  );
  const seen = new Map<number, KeikkaSearchHit>();
  for (const r of rows || []) {
    const id = Number(r.keikkaId);
    if (seen.has(id)) continue;
    seen.set(id, {
      keikkaId: id,
      title: (r.keikkaOtsikko as string) ?? null,
      pumppuAika: r.pumppuAika != null ? String(r.pumppuAika) : null,
      customerName: (r.asiakasNimi as string) ?? null,
      worksiteName: (r.tyomaaNimi as string) ?? null,
      address: (r.osoite as string) ?? null,
      contactPerson: (r.contactPerson as string) ?? null,
      contactPhone: (r.contactPhone as string) ?? null,
    });
  }
  const items = [...seen.values()].slice(0, limit ?? seen.size);
  return listEnvelope(items);
}

/**
 * POST /api/keikka/newKeikka with a free-form body forwarded to the existing
 * BE endpoint. Write flags are surfaced as `X-Dry-Run`, `Idempotency-Key`,
 * and `X-Action-Reason` headers.
 */
export async function runKeikkaCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/keikka/newKeikka", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Update a keikka. v1.0 supports only `--status` (the lifecycle keikkaTilaId);
 * other fields are deferred until the dedicated CLI mutation routes ship (v1.1).
 * Posts the numeric keikkaTilaId to `/api/keikka/tila/set` with the universal
 * write-flag headers.
 */
export async function runKeikkaUpdate(
  client: ApiClient,
  keikkaId: number,
  fields: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  if (!("status" in fields)) {
    throw new Error(
      "v1.0 only supports --status; other fields are pending v1.1"
    );
  }
  // --status is a keikkaTilaId and MUST go to /api/keikka/tila/set as
  // `keikkaTilaId`. The older /setStatus endpoint ignores a `tila` field (it
  // saves per-section completion flags), so posting there silently no-ops the
  // lifecycle-state change.
  const keikkaTilaId = Number(fields.status);
  if (!Number.isInteger(keikkaTilaId)) {
    failWith(
      `--status must be a numeric keikkaTilaId (e.g. 9 = Toimitettu); got "${String(fields.status)}"`,
      4
    );
  }
  return client.post<unknown>(
    "/api/keikka/tila/set",
    { keikkaId, keikkaTilaId },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /api/keikka/defaultDriver/assign/:keikkaId with an empty body. The
 * backend uses the JWT/keikka context to pick the appropriate default
 * driver; the CLI just forwards write flags.
 */
export async function runKeikkaDriversAssign(
  client: ApiClient,
  keikkaId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    `/api/keikka/defaultDriver/assign/${keikkaId}`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * GET /api/cli/keikka/validate/:keikkaId (single) or
 * GET /api/cli/keikka/validate?date=YYYY-MM-DD (day).
 */
export async function runKeikkaValidate(
  client: ApiClient,
  opts: { keikkaId?: number; date?: string }
): Promise<unknown> {
  if (opts.date) {
    return client.get(`/api/cli/keikka/validate?date=${encodeURIComponent(opts.date)}`);
  }
  if (opts.keikkaId != null) {
    return client.get(`/api/cli/keikka/validate/${opts.keikkaId}`);
  }
  return failWith("Pass a keikkaId or --date <YYYY-MM-DD>", 4);
}

/** One raw row from GET /api/cli/keikka/persons/:keikkaId (keikkaPerson + person + source JOIN). */
interface KeikkaPersonRawRow {
  keikkaPersonId: number;
  personId: number;
  personFirstName?: string | null;
  personLastName?: string | null;
  personEmail?: string | null;
  personPhone?: string | null;
  keikkaPersonSourceId?: number | null;
  keikkaPersonSourceText?: string | null;
  contactPersonTypeId?: number | null;
  entryTime?: string | null;
  authRead?: boolean | number;
  authEdit?: boolean | number;
  authListPersons?: boolean | number;
  authAddPerson?: boolean | number;
  authEditPerson?: boolean | number;
}

/** One projected RAW list row — one entry per keikkaPerson row (fb#833). */
export interface KeikkaPersonListItem {
  keikkaPersonId: number;
  personId: number;
  name: string;
  email: string | null;
  phone: string | null;
  sourceId: number | null;
  sourceText: string | null;
  contactType: number | null;
  entryTime: string | null;
  authRead: boolean;
  authEdit: boolean;
  authListPersons: boolean;
  authAddPerson: boolean;
  authEditPerson: boolean;
}

/** A `--by-person` collapsed row: every source row one person holds, auth OR-ed. */
export interface KeikkaPersonCollapsedItem {
  personId: number;
  name: string;
  email: string | null;
  phone: string | null;
  rowCount: number;
  sources: { sourceId: number | null; sourceText: string | null }[];
  contactTypes: number[];
  auth: {
    read: boolean;
    edit: boolean;
    listPersons: boolean;
    addPerson: boolean;
    editPerson: boolean;
  };
}

/** A `--count` summary: totals grouped by source (the bloat diagnostic). */
export interface KeikkaPersonCountSummary {
  total: number;
  distinctPersons: number;
  bySource: { sourceId: number | null; sourceText: string | null; count: number }[];
}

function projectKeikkaPersonRow(r: KeikkaPersonRawRow): KeikkaPersonListItem {
  return {
    keikkaPersonId: r.keikkaPersonId,
    personId: r.personId,
    name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
    email: r.personEmail || null,
    phone: r.personPhone || null,
    sourceId: r.keikkaPersonSourceId ?? null,
    sourceText: r.keikkaPersonSourceText || null,
    contactType: r.contactPersonTypeId ?? null,
    entryTime: r.entryTime != null ? String(r.entryTime) : null,
    authRead: Boolean(r.authRead),
    authEdit: Boolean(r.authEdit),
    authListPersons: Boolean(r.authListPersons),
    authAddPerson: Boolean(r.authAddPerson),
    authEditPerson: Boolean(r.authEditPerson),
  };
}

/**
 * Collapse the raw rows per person (`--by-person`). keikkaPerson is UNIQUE on
 * (personId, keikkaId, keikkaPersonSourceId[, contactPersonTypeId]), so one
 * person legitimately holds several rows — one per source. Collapsing is
 * OPT-IN for exactly that reason: a silent fold would hide the per-source
 * multiplicity this command exists to diagnose (fb#833). Auth flags OR across
 * the person's rows (any row granting edit means the person holds edit).
 */
function collapseByPerson(items: KeikkaPersonListItem[]): KeikkaPersonCollapsedItem[] {
  const byPerson = new Map<number, KeikkaPersonCollapsedItem>();
  for (const item of items) {
    let entry = byPerson.get(item.personId);
    if (!entry) {
      entry = {
        personId: item.personId,
        name: item.name,
        email: item.email,
        phone: item.phone,
        rowCount: 0,
        sources: [],
        contactTypes: [],
        auth: { read: false, edit: false, listPersons: false, addPerson: false, editPerson: false },
      };
      byPerson.set(item.personId, entry);
    }
    entry.rowCount += 1;
    // name/email/phone repeat on every row; keep the first non-empty spelling.
    if (!entry.name && item.name) entry.name = item.name;
    if (!entry.email && item.email) entry.email = item.email;
    if (!entry.phone && item.phone) entry.phone = item.phone;
    entry.sources.push({ sourceId: item.sourceId, sourceText: item.sourceText });
    if (item.contactType != null && !entry.contactTypes.includes(item.contactType)) {
      entry.contactTypes.push(item.contactType);
    }
    entry.auth.read = entry.auth.read || item.authRead;
    entry.auth.edit = entry.auth.edit || item.authEdit;
    entry.auth.listPersons = entry.auth.listPersons || item.authListPersons;
    entry.auth.addPerson = entry.auth.addPerson || item.authAddPerson;
    entry.auth.editPerson = entry.auth.editPerson || item.authEditPerson;
  }
  return [...byPerson.values()];
}

/**
 * GET /api/cli/keikka/persons/:keikkaId — the persons attached to a keikka.
 *
 * The backend route returns one row PER keikkaPerson row with the source id
 * resolved to keikkaPersonSourceText server-side (fb#833). This is the raw
 * surface the FE list route lacks: keikkaPersonView groups per person and
 * keeps only MAX(keikkaPersonSourceId), hiding the per-source multiplicity
 * (same person, one row per source: 1 created-by, 10/11 asiakas mirror /
 * contact, 20/21 tyomaa mirror / contact, 30/31 manual / keikka contact,
 * 50 pumppari).
 *
 * Modes:
 *   - default    ListEnvelope of RAW rows (one per keikkaPerson row)
 *   - --by-person  collapsed per personId (rowCount, sources[], auth OR-ed)
 *   - --count    { summary: { total, distinctPersons, bySource[] } }
 *   - --source   filters rows by keikkaPersonSourceId before any of the above
 *
 * `--by-person` and `--count` are mutually exclusive (exit 4). Deploy-gated:
 * 404 until the backend ships /api/cli/keikka/persons.
 */
export async function runKeikkaPersonList(
  client: ApiClient,
  keikkaId: number,
  opts: { source?: number; byPerson?: boolean; count?: boolean } = {}
): Promise<
  | ListEnvelope<KeikkaPersonListItem>
  | ListEnvelope<KeikkaPersonCollapsedItem>
  | { summary: KeikkaPersonCountSummary }
> {
  if (opts.byPerson && opts.count) {
    failWith("--by-person and --count are mutually exclusive — pass one or the other", 4);
  }
  const rows = await client.get<KeikkaPersonRawRow[]>(
    `/api/cli/keikka/persons/${keikkaId}`
  );
  const filtered = (rows || []).filter(
    (r) => opts.source === undefined || (r.keikkaPersonSourceId ?? null) === opts.source
  );
  if (opts.count) {
    const bySource = new Map<number | null, { sourceId: number | null; sourceText: string | null; count: number }>();
    const persons = new Set<number>();
    for (const r of filtered) {
      persons.add(r.personId);
      const id = r.keikkaPersonSourceId ?? null;
      const entry = bySource.get(id);
      if (entry) {
        entry.count += 1;
      } else {
        bySource.set(id, { sourceId: id, sourceText: r.keikkaPersonSourceText || null, count: 1 });
      }
    }
    return {
      summary: {
        total: filtered.length,
        distinctPersons: persons.size,
        bySource: [...bySource.values()].sort((a, b) => (a.sourceId ?? -1) - (b.sourceId ?? -1)),
      },
    };
  }
  const items = filtered.map(projectKeikkaPersonRow);
  return opts.byPerson ? listEnvelope(collapseByPerson(items)) : listEnvelope(items);
}

/**
 * Register `ib keikka` subcommands on the parent commander instance:
 *   - list     filterable by --from/--to/--customer/--vehicle/--worksite/--status/--limit/--cursor
 *   - get      single keikka by id
 *   - create   POST /api/keikka/newKeikka with --body JSON (write flags)
 *   - update   POST /api/keikka/setStatus (v1.0: --status only)
 *   - drivers  drivers assign <keikkaId> → POST default-driver assignment
 *   - person   person list <keikkaId> → raw keikkaPerson rows (GET /api/cli/keikka/persons/:id)
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerKeikkaCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const k = parent.command("keikka").description("Keikka commands");

  k.command("list")
    .option("--from <date>", "", "today")
    .option("--to <date>", "", "today")
    .option(
      "--date <date>"
    )
    .option("--customer <id>", "", intFlag("--customer", 1))
    .option("--vehicle <id>", "", intFlag("--vehicle", 1))
    .option("--worksite <id>", "", intFlag("--worksite", 1))
    .option("--status <s>")
    .option("--limit <n>", "", cappedInt(500))
    .option("--cursor <c>")
    .action(
      guarded(async (rawOpts: KeikkaListFilter & { date?: string }, command: Command) => {
        const client = await getClient();
        const { date, ...opts } = rawOpts;
        let { from, to } = opts;
        // --date is a single-day convenience (fb#236): an AI reaching for a
        // `--date` on `keikka list` (schedule commands own dates) now works
        // instead of hitting "unknown option". It expands to from=to=<day>; a
        // conflict with an EXPLICIT --from/--to (the source is "cli", not the
        // "today" default) is a caller error, not a silent override.
        if (date !== undefined) {
          if (
            command.getOptionValueSource("from") === "cli" ||
            command.getOptionValueSource("to") === "cli"
          ) {
            failWith(
              "--date is a single-day shorthand for --from/--to — pass it alone, not together with --from/--to",
              4
            );
          }
          from = date;
          to = date;
        }
        const resolved: KeikkaListFilter = {
          ...opts,
          from: resolveDate(from),
          to: resolveDate(to),
        };
        const result = await runKeikkaList(client, resolved);
        writeJson(result);
      })
    );

  k.command("latest")
    .option("--status <s>")
    .option("--customer <id>", "", intFlag("--customer", 1))
    .option("--vehicle <id>", "", intFlag("--vehicle", 1))
    .option("--worksite <id>", "", intFlag("--worksite", 1))
    .option(
      "--lookback <days>",
      "",
      intFlag("--lookback", 0)
    )
    .action(
      jsonAction(getClient, (client, opts: KeikkaLatestFilter) => runKeikkaLatest(client, opts))
    );

  k.command("get <keikkaId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runKeikkaGet(client, parseId(idStr, "keikkaId"))
      )
    );

  k.command("search [query]")
    .option("--search <s>")
    .addOption(queryAliasOption())
    .option("--limit <n>", "", cappedInt(100))
    .action(
      guarded(async (query: string | undefined, opts: { search?: string; query?: string; limit?: number }) => {
        const client = await getClient();
        const ownerAsiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
        const result = await runKeikkaSearch(client, resolveSearchQuery(query, opts.search, opts.query), ownerAsiakasId, opts.limit);
        writeJson(result);
      })
    );

  k.command("validate [keikkaId]")
    .option("--date <date>")
    .action(
      guarded(async (idStr: string | undefined, opts: { date?: string }) => {
        const client = await getClient();
        if (opts.date && idStr) {
          failWith("Pass either a keikkaId or --date, not both", 4);
        }
        const result = await runKeikkaValidate(client, {
          keikkaId: idStr ? parseId(idStr, "keikkaId") : undefined,
          date: opts.date ? resolveDate(opts.date) : undefined,
        });
        writeJson(result);
      })
    );

  const createCmd = addJsonBodyOptions(k.command("create"));
  addWriteFlagsToCommand(createCmd).action(
    guarded(async (opts: WriteFlags & JsonBodyFlags, cmd: Command) => {
      const parsed = resolveJsonBody(cmd, opts, { required: true })!;
      const client = await getClient();
      const result = await runKeikkaCreate(client, parsed, opts);
      writeJson(result);
    })
  );

  const updateCmd = k
    .command("update <keikkaId>")
    .option("--status <s>");
  addWriteFlagsToCommand(updateCmd).action(
    guarded(async (idStr: string, opts: WriteFlags & { status?: string }) => {
      if (opts.status === undefined) {
        failWith("Nothing to update: pass --status (v1.0 supports --status only)", 4);
      }
      const client = await getClient();
      const result = await runKeikkaUpdate(
        client,
        parseId(idStr, "keikkaId"),
        { status: opts.status },
        opts
      );
      writeJson(result);
    })
  );

  const drivers = k.command("drivers").description("Driver assignment commands");
  const assignCmd = drivers
    .command("assign <keikkaId>");
  addWriteFlagsToCommand(assignCmd).action(
    jsonAction(getClient, (client, idStr: string, opts: WriteFlags) =>
      runKeikkaDriversAssign(client, parseId(idStr, "keikkaId"), opts)
    )
  );

  const keikkaPerson = k
    .command("person")
    .description("Persons attached to a keikka (keikkaPerson links)");

  keikkaPerson
    .command("list [keikkaId]")
    .option("--keikka <id>", "", Number)
    .option("--source <id>", "", intFlag("--source", 1))
    .option("--by-person")
    .option("--count")
    .action(
      jsonAction(
        getClient,
        (
          client,
          keikkaIdStr: string | undefined,
          opts: { keikka?: number; source?: number; byPerson?: boolean; count?: boolean }
        ) =>
          runKeikkaPersonList(
            client,
            resolveTarget(keikkaIdStr, opts.keikka, "keikkaId", "keikka"),
            { source: opts.source, byPerson: opts.byPerson, count: opts.count }
          )
      )
    );

  registerLogAlias(
    k,
    getClient,
    "keikka",
    "keikkaId",
    "Filter by changeTracker fieldName (e.g. kuskit, laskuMemo)"
  );
}
