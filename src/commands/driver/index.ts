import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";

type Row = Record<string, unknown>;

/** YYYY-MM-DD (or today/yesterday/tomorrow) → integer yyyymmdd. */
function toYyyymmdd(date: string): number {
  return Number(resolveDate(date)!.replace(/-/g, ""));
}

/** GET /api/cli/driver/board/:yyyymmdd — every grid-eligible vehicle + driver/gap + keikka context. */
export async function runDriverBoard(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/board/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/gaps/:yyyymmdd — vehicles needing a driver (the "Ei kuljettajaa" list). */
export async function runDriverGaps(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/gaps/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/available/:yyyymmdd — drivers free + not absent that day. */
export async function runDriverAvailable(
  client: ApiClient,
  date: string
): Promise<ListEnvelope<Row>> {
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/available/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/who/:vehicleId/:yyyymmdd — the day driver of one vehicle. */
export async function runDriverWho(
  client: ApiClient,
  vehicleId: number,
  date: string
): Promise<Row> {
  return client.get<Row>(`/api/cli/driver/who/${vehicleId}/${toYyyymmdd(date)}`);
}

/** GET /api/cli/driver/absences?from=&to=&personId= — personPvm pois rows in a range. */
export async function runDriverAbsences(
  client: ApiClient,
  opts: { from: string; to: string; person?: number }
): Promise<ListEnvelope<Row>> {
  const params = new URLSearchParams();
  params.set("from", resolveDate(opts.from) ?? opts.from);
  params.set("to", resolveDate(opts.to) ?? opts.to);
  if (opts.person !== undefined) params.set("personId", String(opts.person));
  return client.get<ListEnvelope<Row>>(`/api/cli/driver/absences?${params.toString()}`);
}

/** POST /api/cli/driver/assign — atomic day-driver assign (writes personPvm + keikka + palkki). */
export async function runDriverAssign(
  client: ApiClient,
  vehicleId: number,
  personId: number,
  date: string,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/cli/driver/assign",
    { vehicleId, personId, yyyymmdd: toYyyymmdd(date) },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/** POST /api/cli/driver/clear — atomic day-driver clear (personId=null). */
export async function runDriverClear(
  client: ApiClient,
  vehicleId: number,
  date: string,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/cli/driver/clear",
    { vehicleId, yyyymmdd: toYyyymmdd(date) },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * Register `ib driver` — person/day-centric day-driver management.
 * Reads: board, gaps, available, who, absences.
 * Writes: assign, clear (atomic; --reason hard-required; carry write-safety flags).
 * Complements the vehicle-centric `ib vehicle driver-assign`/`drivers`.
 * `src/reference/specs.ts` is the source of truth for flags/permissions/output.
 */
export function registerDriverCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const d = parent.command("driver").description("Day-driver management (person/day-centric)");

  d.command("board <date>")
    .description("All grid-eligible vehicles for a day with their driver / gap / keikka load")
    .action(async (date: string) => {
      try {
        writeJson(await runDriverBoard(await getClient(), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  d.command("gaps <date>")
    .description("Vehicles needing a driver that day (the 'Ei kuljettajaa' list)")
    .action(async (date: string) => {
      try {
        writeJson(await runDriverGaps(await getClient(), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  d.command("available <date>")
    .description("Assignable drivers free that day and not on vacation")
    .action(async (date: string) => {
      try {
        writeJson(await runDriverAvailable(await getClient(), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  d.command("who <vehicleId> <date>")
    .description("The day driver assigned to a vehicle on a date")
    .action(async (vehicleIdStr: string, date: string) => {
      try {
        writeJson(await runDriverWho(await getClient(), Number(vehicleIdStr), date));
      } catch (e) {
        exitWithError(e);
      }
    });

  d.command("absences")
    .description("Driver absences (vacation/sick) in a date range")
    .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .requiredOption("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .option("--person <pid>", "Filter to one driver personId", (s: string) => Number(s))
    .action(async (opts: { from: string; to: string; person?: number }) => {
      try {
        writeJson(await runDriverAbsences(await getClient(), opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  const assignCmd = d
    .command("assign")
    .description("Assign a day driver to a vehicle (atomic: personPvm + keikkat + palkit). Requires --reason.")
    .requiredOption("--vehicle <id>", "Target vehicleId", (s: string) => Number(s))
    .requiredOption("--person <pid>", "Driver personId", (s: string) => Number(s))
    .option("--date <d>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)", "today");
  addWriteFlagsToCommand(assignCmd).action(
    async (opts: WriteFlags & { vehicle: number; person: number; date: string }) => {
      if (!opts.reason) {
        writeError(new Error("Missing required flag: --reason"));
        process.exit(4);
      }
      try {
        const result = await runDriverAssign(
          await getClient(),
          opts.vehicle,
          opts.person,
          opts.date,
          { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const clearCmd = d
    .command("clear")
    .description("Clear the day driver from a vehicle (atomic). Requires --reason.")
    .requiredOption("--vehicle <id>", "Target vehicleId", (s: string) => Number(s))
    .option("--date <d>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)", "today");
  addWriteFlagsToCommand(clearCmd).action(
    async (opts: WriteFlags & { vehicle: number; date: string }) => {
      if (!opts.reason) {
        writeError(new Error("Missing required flag: --reason"));
        process.exit(4);
      }
      try {
        const result = await runDriverClear(
          await getClient(),
          opts.vehicle,
          opts.date,
          { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
