import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { resolveDate } from "../../dates.js";
import { CliError } from "../../api/errors.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";

type Row = Record<string, unknown>;

/** Active company id (personPvm `:asiakasId`) from the JWT — same pattern as `vehicle create`. */
function ownerAsiakasIdOf(client: ApiClient): number {
  const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken()) as { ownerAsiakasId?: number };
  if (typeof ownerAsiakasId !== "number" || ownerAsiakasId <= 0) {
    throw new Error("could not resolve active company from token — run `ib auth switch`");
  }
  return ownerAsiakasId;
}

/** 20260610 → "2026-06-10". */
function intToDate(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** date alias/ISO → integer yyyymmdd. */
function toYyyymmdd(date: string): number {
  return Number(resolveDate(date)!.replace(/-/g, ""));
}

export interface StatusRow {
  statusId: number;
  code: string | null;
  name: string | null;
  pois: boolean;
  vakioVapaa: boolean;
}

/** GET /api/personPvm/statusList/:asiakasId — the day-status types for the active company. */
export async function runPersonDayStatuses(
  client: ApiClient
): Promise<ListEnvelope<StatusRow>> {
  const asiakasId = ownerAsiakasIdOf(client);
  const rows = await client.get<Row[]>(`/api/personPvm/statusList/${asiakasId}`);
  const items: StatusRow[] = (rows || []).map((r) => ({
    statusId: Number(r.personPvmStatusId),
    code: (r.personPvmStatus as string) ?? null,
    name: (r.personPvmStatusName as string) ?? null,
    pois: !!r.pois,
    vakioVapaa: !!r.vakioVapaa,
  }));
  return { items, nextCursor: null, count: items.length };
}

/** GET /api/personPvm/list/:asiakasId — a person's day rows over [from, to] (to defaults to from). */
export async function runPersonDayGet(
  client: ApiClient,
  personId: number,
  from: string,
  to?: string
): Promise<ListEnvelope<Row>> {
  const asiakasId = ownerAsiakasIdOf(client);
  const startDate = resolveDate(from) ?? from;
  const endDate = resolveDate(to ?? from) ?? (to ?? from);
  const params = new URLSearchParams({ startDate, endDate, personId: String(personId) });
  const rows = await client.get<Row[]>(
    `/api/personPvm/list/${asiakasId}?${params.toString()}`
  );
  const items: Row[] = (rows || []).map((r) => ({
    personPvmId: Number(r.personPvmId),
    date: intToDate(Number(r.pvm)),
    statusId: r.personPvmStatusId != null ? Number(r.personPvmStatusId) : null,
    status: (r.personPvmStatus as string) ?? null,
    statusName: (r.personPvmStatusName as string) ?? null,
    pois: !!r.pois,
    vehicleId: r.vehicleId != null ? Number(r.vehicleId) : null,
    text: (r.personPvmText as string) ?? null,
  }));
  return { items, nextCursor: null, count: items.length };
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
  const lc = v.toLowerCase();
  const matches = items.filter(
    (s) =>
      (s.code && s.code.toLowerCase() === lc) ||
      (s.name && s.name.toLowerCase() === lc)
  );
  const candidates = items.map((s) => `${s.statusId}:${s.name ?? s.code}`).join(", ");
  if (matches.length === 1) return matches[0].statusId;
  if (matches.length === 0) {
    throw new CliError(`No status matches "${value}". Available: ${candidates}`, 400, null, 4);
  }
  throw new CliError(`Status "${value}" is ambiguous — use the id. Available: ${candidates}`, 400, null, 4);
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
    .description("List the day-status types (vacation/sick/free/…) for the active company")
    .action(async () => {
      try {
        writeJson(await runPersonDayStatuses(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  day
    .command("get")
    .description("List a person's day rows (status / vehicle / text) over a date range")
    .requiredOption("--person <id>", "personId", (s: string) => Number(s))
    .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .option("--to <date>", "End date YYYY-MM-DD (default: --from)")
    .action(async (opts: { person: number; from: string; to?: string }) => {
      try {
        writeJson(await runPersonDayGet(await getClient(), opts.person, opts.from, opts.to));
      } catch (e) {
        exitWithError(e);
      }
    });

  // set + clear are added in later tasks.
  void writeError;
  void writeFlagsToHeaders;
  void addWriteFlagsToCommand;
  void toYyyymmdd;
}

export type { WriteFlags };
