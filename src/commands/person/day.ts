import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith, warnNote } from "../../output/json.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { resolveDate, toYyyymmddInt, addDaysISO, isIsoDateOrDateTime } from "../../dates.js";
import { diffFields } from "../../diff.js";
import { jsonAction, guarded } from "../_shared/action.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { qs } from "../../api/query.js";
import { bothInOrder } from "../../parallel.js";
import { intFlag, zeroOneFlag, resolvePersonTarget } from "../../targets.js";

type Row = Record<string, unknown>;

/** 20260610 → "2026-06-10". */
function intToDate(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export interface StatusRow {
  statusId: number;
  code: string | null;
  name: string | null;
  pois: boolean;
  vakioVapaa: boolean;
}
export interface StatusRowFull extends StatusRow {
  description: string | null;
  prefix: string | null;
  style: string | null;
  active: boolean;
  ownerAsiakasId: number | null;
}

/** GET /api/personPvm/statusList/:asiakasId — the day-status types for the active company. */
export async function runPersonDayStatuses(
  client: ApiClient,
  opts: { full?: boolean } = {}
): Promise<ListEnvelope<StatusRow | StatusRowFull>> {
  const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const rows = await client.get<Row[]>(`/api/personPvm/statusList/${asiakasId}`);
  const items = (rows || []).map((r) => {
    const full = projectStatus(r);
    if (opts.full) return full;
    const { statusId, code, name, pois, vakioVapaa } = full;
    return { statusId, code, name, pois, vakioVapaa } as StatusRow;
  });
  return listEnvelope(items);
}

/** GET /api/personPvm/list/:asiakasId — a person's day rows over [from, to] (to defaults to from). */
export async function runPersonDayGet(
  client: ApiClient,
  personId: number,
  from: string,
  to?: string
): Promise<ListEnvelope<Row>> {
  const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const startDate = resolveDate(from) ?? from;
  const endDate = resolveDate(to ?? from) ?? (to ?? from);
  const rows = await client.get<Row[]>(
    `/api/personPvm/list/${asiakasId}${qs({ startDate, endDate, personId })}`
  );
  const items: Row[] = (rows || []).map((r) => ({
    personPvmId: Number(r.personPvmId),
    date: intToDate(Number(r.pvm)),
    statusId: r.personPvmStatusId != null ? Number(r.personPvmStatusId) : null,
    status: (r.personPvmStatus as string) ?? null,
    pois: !!r.pois,
    vehicleId: r.vehicleId != null ? Number(r.vehicleId) : null,
    text: (r.personPvmText as string) ?? null,
  }));
  return listEnvelope(items);
}

/**
 * Resolve a `--status` value to a personPvmStatusId. All-digits → used as-is.
 * Otherwise fetch statusList once and match case-insensitively on code/name.
 * No / ambiguous match → CliError exit 4 listing the candidates.
 */
export async function resolveStatusId(client: ApiClient, value: string): Promise<number> {
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const { items } = await runPersonDayStatuses(client);
  return matchStatusId(items, v);
}

/** The pure half of {@link resolveStatusId}: match an id or code/name against a fetched list. */
export function matchStatusId(items: StatusRow[], value: string): number {
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const lc = v.toLowerCase();
  const matches = items.filter(
    (s) =>
      (s.code && s.code.toLowerCase() === lc) ||
      (s.name && s.name.toLowerCase() === lc)
  );
  const candidates = items.map((s) => `${s.statusId}:${s.name ?? s.code}`).join(", ");
  if (matches.length === 1) return matches[0].statusId;
  if (matches.length === 0) {
    failWith(`No status matches "${value}". Available: ${candidates}`, 4);
  }
  failWith(`Status "${value}" is ambiguous — use the id. Available: ${candidates}`, 4);
}

export interface PersonDaySetFlags extends WriteFlags {
  text?: string;
}

/**
 * Set a person's day availability status. Read-merges the existing row for that
 * person+date (so a re-set UPDATES rather than inserting a duplicate via
 * personPvm_save2's null-id insert path). `--dry-run` is CLIENT-side (the save
 * endpoint has no X-Dry-Run guard) — it returns a wouldChange diff and never POSTs.
 * When --text is omitted the existing text is preserved (not wiped). The existing
 * vehicleId is ALWAYS threaded back — the proc's UPDATE branch sets vehicleId
 * unconditionally, so omitting it would null the day's driver and strip the
 * person from that day's pump keikkat.
 */
export async function runPersonDaySet(
  client: ApiClient,
  personId: number,
  date: string,
  statusValue: string,
  flags: PersonDaySetFlags
): Promise<unknown> {
  const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const pvm = toYyyymmddInt(date);
  // The status lookup (only issued for a non-numeric --status) is keyed on the
  // status name; the day read on person+date. Independent, so run them together —
  // ordered so a bad --status still reports the validation error, not whichever
  // of the two failed first.
  const [statusId, existing] = await bothInOrder(
    resolveStatusId(client, statusValue),
    runPersonDayGet(client, personId, date, date)
  );
  const current = existing.items[0] as Row | undefined;
  const curStatusId = current ? ((current.statusId as number | null) ?? null) : null;
  const curText = current ? ((current.text as string | null) ?? null) : null;
  const curVehicleId = current ? ((current.vehicleId as number | null) ?? null) : null;
  const nextText = flags.text ?? curText ?? null;

  if (flags.dryRun) {
    const wouldChange: Record<string, { from: unknown; to: unknown }> = {};
    if (curStatusId !== statusId) wouldChange.status = { from: curStatusId, to: statusId };
    if ((curText ?? null) !== (nextText ?? null)) wouldChange.text = { from: curText ?? null, to: nextText ?? null };
    return { dryRun: true, personId, date: resolveDate(date), wouldChange };
  }

  const body: Record<string, unknown> = {
    personId,
    pvm,
    personPvmStatusId: statusId,
    personPvmText: nextText,
    vehicleId: curVehicleId,
  };
  if (current) body.personPvmId = current.personPvmId;
  return client.post(`/api/personPvm/save/${asiakasId}`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** Longest range one `day set --from/--to` call may write (fb#2945) — a long sick leave fits. */
export const MAX_RANGE_DAYS = 186;

export interface PersonDaySetRangeFlags extends PersonDaySetFlags {
  weekdaysOnly?: boolean;
}

/**
 * `ib person day set --from/--to` (fb#2945): the single-day set over a date range,
 * with ONE status-list read and ONE day-list read for the whole range, then one save
 * per day — same read-merge semantics (existing row updated in place, vehicle and
 * text preserved). A day already holding the target status and text is skipped as
 * `unchanged`, so re-running the same command after a mid-range failure resumes.
 * `--weekdays-only` skips Saturdays/Sundays and days already holding a vakioVapaa
 * status (a holiday someone entered). `--idempotency-key` is suffixed per day
 * (`<key>:<date>`) — one key on 65 different writes would collide.
 */
export async function runPersonDaySetRange(
  client: ApiClient,
  personId: number,
  fromInput: string,
  toInput: string,
  statusValue: string,
  flags: PersonDaySetRangeFlags
): Promise<unknown> {
  const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const from = resolveDate(fromInput)!;
  const to = resolveDate(toInput)!;
  for (const [flag, d] of [["--from", from], ["--to", to]]) {
    // isIsoDateOrDateTime rejects 2026-02-30, which Date.parse rolls over (fb#2967).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isIsoDateOrDateTime(d)) failWith(`${flag}: expected YYYY-MM-DD, got "${d}"`, 4);
  }
  if (to < from) failWith(`--to (${to}) is before --from (${from})`, 4);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) days.push(d);
  if (days.length > MAX_RANGE_DAYS) failWith(`range is ${days.length} days; at most ${MAX_RANGE_DAYS} per call — split it`, 4);

  const [statuses, existing] = await bothInOrder(runPersonDayStatuses(client), runPersonDayGet(client, personId, from, to));
  const statusId = matchStatusId(statuses.items, statusValue);
  const vakioVapaaIds = new Set(statuses.items.filter((s) => s.vakioVapaa).map((s) => s.statusId));
  const byDate = new Map(existing.items.map((r) => [r.date as string, r]));

  const skipped: { date: string; reason: string }[] = [];
  const unchanged: string[] = [];
  const pending: { date: string; current?: Row; nextText: string | null }[] = [];
  for (const date of days) {
    const current = byDate.get(date);
    const curStatusId = (current?.statusId as number | null) ?? null;
    if (flags.weekdaysOnly) {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) { skipped.push({ date, reason: "weekend" }); continue; }
      if (curStatusId != null && curStatusId !== statusId && vakioVapaaIds.has(curStatusId)) {
        skipped.push({ date, reason: `vakioVapaa status ${curStatusId}` });
        continue;
      }
    }
    const curText = (current?.text as string | null) ?? null;
    const nextText = flags.text ?? curText;
    if (curStatusId === statusId && curText === nextText) { unchanged.push(date); continue; }
    pending.push({ date, current, nextText });
  }

  const base = { personId, from, to, statusId, skipped, unchanged };
  if (flags.dryRun) {
    const wouldChange = pending.map(({ date, current, nextText }) => ({
      date,
      status: { from: (current?.statusId as number | null) ?? null, to: statusId },
      ...(((current?.text as string | null) ?? null) !== nextText ? { text: { from: current?.text ?? null, to: nextText } } : {}),
    }));
    return { dryRun: true, ...base, wouldChange, count: wouldChange.length };
  }

  const set: string[] = [];
  for (const { date, current, nextText } of pending) {
    const body: Record<string, unknown> = {
      personId,
      pvm: toYyyymmddInt(date),
      personPvmStatusId: statusId,
      personPvmText: nextText,
      vehicleId: (current?.vehicleId as number | null) ?? null,
    };
    if (current) body.personPvmId = current.personPvmId;
    const headers = writeFlagsToHeaders({ ...flags, idempotencyKey: flags.idempotencyKey && `${flags.idempotencyKey}:${date}` });
    try {
      await client.post(`/api/personPvm/save/${asiakasId}`, body, { headers });
    } catch (e) {
      warnNote(`[ib] person day set: ${set.length} of ${pending.length} days saved before ${date} failed (saved: ${set.join(", ") || "none"}) — re-run the same command to resume (saved days come back as unchanged).`);
      throw e;
    }
    set.push(date);
  }
  return { ...base, set, count: set.length };
}

/** The editable fields of a day-status type, keyed by CLI flag → backend column. */
const STATUS_FIELDS = {
  name: "personPvmStatusName",
  code: "personPvmStatus",
  description: "personPvmStatusDescription",
  pois: "pois",
  vakioVapaa: "vakioVapaa",
  style: "style",
  prefix: "prefix",
  active: "active",
} as const;
type StatusFieldFlag = keyof typeof STATUS_FIELDS;

export type PersonDayStatusFlags = WriteFlags & {
  name?: string;
  code?: string;
  description?: string;
  pois?: number;
  vakioVapaa?: number;
  style?: string;
  prefix?: string;
  active?: number;
};

/** Backend row → the projected {@link StatusRowFull} shape `day statuses --full` prints. */
function projectStatus(r: Row): StatusRowFull {
  return {
    statusId: Number(r.personPvmStatusId),
    code: (r.personPvmStatus as string) ?? null,
    name: (r.personPvmStatusName as string) ?? null,
    pois: !!r.pois,
    vakioVapaa: !!r.vakioVapaa,
    description: (r.personPvmStatusDescription as string) ?? null,
    prefix: (r.prefix as string) ?? null,
    style: (r.style as string) ?? null,
    active: !!r.active,
    ownerAsiakasId: r.ownerAsiakasId != null ? Number(r.ownerAsiakasId) : null,
  };
}

/** Apply the given flags onto a backend status row (0/1 flags become booleans). */
function mergeStatusFlags(row: Row, flags: PersonDayStatusFlags): Row {
  if (flags.prefix && flags.prefix.length > 2) failWith("--prefix is at most 2 characters", 4);
  const next: Row = { ...row };
  for (const flag of Object.keys(STATUS_FIELDS) as StatusFieldFlag[]) {
    const v = flags[flag];
    if (v === undefined) continue;
    next[STATUS_FIELDS[flag]] = typeof v === "number" ? v === 1 : v;
  }
  return next;
}

/**
 * `ib person day status create` (fb#2944): a new day-status type owned by the active
 * company. The backend pins the owner from the token. Defaults: --code = --name,
 * pois 1 (an absence), vakioVapaa 0, active 1. `--dry-run` is client-side.
 */
export async function runPersonDayStatusCreate(client: ApiClient, flags: PersonDayStatusFlags): Promise<unknown> {
  if (!flags.name) failWith("--name is required", 4);
  const body = mergeStatusFlags(
    { personPvmStatusId: -1, personPvmStatus: flags.name, pois: true, vakioVapaa: false, active: true, prefix: "", style: null, personPvmStatusDescription: null },
    flags
  );
  if (flags.dryRun) return { dryRun: true, wouldCreate: body };
  const saved = await client.post<Row>("/api/personPvm/status/save", body, { headers: writeFlagsToHeaders(flags) });
  return projectStatus(saved);
}

/**
 * `ib person day status update <statusId>` (fb#2944). Read-merge-write: the save
 * overwrites EVERY column, so the current row is read first and only the given
 * flags change. Global statuses (ownerAsiakasId null) are refused by the backend
 * unless the caller is a system admin/developer. `--dry-run` is client-side.
 */
export async function runPersonDayStatusUpdate(client: ApiClient, statusId: number, flags: PersonDayStatusFlags): Promise<unknown> {
  const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const rows = await client.get<Row[]>(`/api/personPvm/statusList/${asiakasId}`);
  const current = (rows || []).find((r) => Number(r.personPvmStatusId) === statusId);
  if (!current) failWith(`No status ${statusId} for the active company — see \`ib person day statuses\``, 5);
  const next = mergeStatusFlags(current, flags);
  if (flags.dryRun) {
    return { dryRun: true, statusId, wouldChange: diffFields(current, next, Object.values(STATUS_FIELDS)) };
  }
  const saved = await client.post<Row>("/api/personPvm/status/save", next, { headers: writeFlagsToHeaders(flags) });
  return projectStatus(saved);
}

/**
 * Delete a person's personPvm row for a date (remove the status entry).
 * Resolves the personPvmId via the day list first. `--dry-run` is CLIENT-side
 * (returns wouldDelete, no DELETE). No row → a clean "nothing to delete" result.
 */
export async function runPersonDayClear(
  client: ApiClient,
  personId: number,
  date: string,
  flags: WriteFlags
): Promise<unknown> {
  const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
  const existing = await runPersonDayGet(client, personId, date, date);
  const current = existing.items[0] as Row | undefined;

  if (flags.dryRun) {
    return {
      dryRun: true,
      wouldDelete: current
        ? {
            personPvmId: current.personPvmId,
            date: intToDate(toYyyymmddInt(date)),
            status: (current.status as string) ?? null,
          }
        : null,
    };
  }
  if (!current) {
    return { deleted: false, message: "no personPvm row for that person/date" };
  }
  return client.delete(`/api/personPvm/delete/${asiakasId}/${current.personPvmId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Register `ib person day` on the existing `person` command.
 * Reads: statuses, get. Writes: set, clear (added in later tasks).
 */
export function registerPersonDayCommands(
  person: Command,
  getClient: () => Promise<ApiClient>
): void {
  const day = person
    .command("day")
    .description("Person-day availability (personPvm status) management");

  day
    .command("statuses")
    .option("--full")
    .action(
      jsonAction(getClient, (client, opts: { full?: boolean }) =>
        runPersonDayStatuses(client, { full: opts.full })
      )
    );

  day
    .command("get [personId]")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .option("--person <id>", "", intFlag("--person", 1))
    .requiredOption("--from <date>")
    .option("--to <date>")
    .action(
      jsonAction(getClient, (client, personId: string | undefined, opts: { person?: number; from: string; to?: string }) =>
        runPersonDayGet(client, resolvePersonTarget(personId, opts.person), opts.from, opts.to)
      )
    );

  const setCmd = day
    .command("set [personId]")
    .option("--person <id>", "", intFlag("--person", 1))
    .option("--date <date>")
    .option("--from <date>")
    .option("--to <date>")
    .option("--weekdays-only")
    .requiredOption("--status <id|name>")
    .option("--text <s>");
  addWriteFlagsToCommand(setCmd).action(
    guarded(async (personId: string | undefined, opts: PersonDaySetRangeFlags & { person?: number; date?: string; from?: string; to?: string; status: string }) => {
      const target = resolvePersonTarget(personId, opts.person);
      // Exactly one of --date (one day) or --from[/--to] (a range, fb#2945).
      if (!!opts.date === !!opts.from) failWith("pass either --date <date> or --from <date> [--to <date>]", 4);
      if (opts.to && !opts.from) failWith("--to needs --from", 4);
      if (opts.weekdaysOnly && !opts.from) failWith("--weekdays-only applies to a --from/--to range", 4);
      const result = opts.from
        ? await runPersonDaySetRange(await getClient(), target, opts.from, opts.to ?? opts.from, opts.status, opts)
        : await runPersonDaySet(await getClient(), target, opts.date!, opts.status, opts);
      writeJson(result);
    })
  );

  const status = day.command("status").description("Create or edit the company's day-status types (vacation/sick/…)");
  const addStatusFieldFlags = (cmd: Command) =>
    cmd
      .option("--name <s>")
      .option("--code <s>")
      .option("--description <s>")
      .option("--pois <0|1>", "", zeroOneFlag("--pois"))
      .option("--vakio-vapaa <0|1>", "", zeroOneFlag("--vakio-vapaa"))
      .option("--style <s>")
      .option("--prefix <s>")
      .option("--active <0|1>", "", zeroOneFlag("--active"));

  addWriteFlagsToCommand(addStatusFieldFlags(status.command("create"))).action(
    guarded(async (opts: PersonDayStatusFlags) => {
      writeJson(await runPersonDayStatusCreate(await getClient(), opts));
    })
  );

  addWriteFlagsToCommand(addStatusFieldFlags(status.command("update <statusId>"))).action(
    guarded(async (statusId: string, opts: PersonDayStatusFlags) => {
      writeJson(await runPersonDayStatusUpdate(await getClient(), intFlag("statusId", 1)(statusId), opts));
    })
  );

  const clearCmd = day
    .command("clear [personId]")
    .option("--person <id>", "", intFlag("--person", 1))
    .requiredOption("--date <date>");
  addWriteFlagsToCommand(clearCmd).action(
    guarded(async (personId: string | undefined, opts: WriteFlags & { person?: number; date: string }) => {
      const result = await runPersonDayClear(await getClient(), resolvePersonTarget(personId, opts.person), opts.date, opts);
      writeJson(result);
    })
  );
}

