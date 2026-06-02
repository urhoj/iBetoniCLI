import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { decodeJwtPayload } from "../../auth/jwt.js";

export interface VehicleListFilter {
  limit?: number;
  cursor?: string;
}

export interface VehicleDriversFilter {
  from?: string;
  to?: string;
}

/**
 * GET /api/cli/vehicle/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runVehicleList(
  client: ApiClient,
  opts: VehicleListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/vehicle/get/:vehicleId. Returns the flat backend record as-is.
 */
export async function runVehicleGet(
  client: ApiClient,
  vehicleId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/vehicle/get/${vehicleId}`
  );
}

/**
 * GET /api/cli/vehicle/status/:vehicleId. Returns the flat status record:
 * current driver, current keikka, and latest GPS ping (or null fields).
 */
export async function runVehicleStatus(
  client: ApiClient,
  vehicleId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/vehicle/status/${vehicleId}`
  );
}

/**
 * GET /api/cli/vehicle/drivers/:vehicleId — driver-assignment history over a
 * date range. Date aliases (today/yesterday/tomorrow) are resolved before the
 * call; query params are appended only when set.
 */
export async function runVehicleDrivers(
  client: ApiClient,
  vehicleId: number,
  opts: VehicleDriversFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/drivers/${vehicleId}${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/vehicle/types — list selectable vehicle types
 * (vehicleTypeId + name) for the active company, in the list envelope shape.
 */
export async function runVehicleTypes(
  client: ApiClient
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    "/api/cli/vehicle/types"
  );
}

/**
 * GET /api/cli/vehicle/list?search=…&limit=… — substring search over the
 * vehicle list (reg-no / name). Reuses the list endpoint with a `search`
 * query param; `limit` is appended only when supplied.
 */
export async function runVehicleSearch(
  client: ApiClient,
  query: string,
  limit?: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams({ search: query });
  if (limit !== undefined) params.set("limit", String(limit));
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/vehicle/list?${params.toString()}`
  );
}

/**
 * The writable subset of a vehicle row. Every field is optional so the same
 * shape backs both create (unspecified → null) and update (unspecified → keep
 * current value via read-merge-write).
 */
export interface VehicleWriteFields {
  vehicleRegNo?: string;
  vehicleNimi?: string;
  vehicleNo?: number;
  vehicleTypeId?: number;
  memo?: string;
  defaultKuski_personId?: number;
  vehicleM3?: number;
  asiakasId?: number;
}

/**
 * Create a vehicle. The backend `vehicle_save` proc is UPDATE-only, so creation
 * is two-step: `POST /api/vehicle/new/:ownerAsiakasId` inserts a blank stub and
 * returns its `vehicleId`, then `POST /api/vehicle/save` populates it.
 *
 * `ownerAsiakasId` is taken from the active JWT. For a dry-run we only hit the
 * `/new` endpoint (with `X-Dry-Run`) and return the backend's preview — no save
 * is attempted. The `--reason` audit string is sent on both calls; the
 * `--idempotency-key` only applies to the populating save.
 */
export async function runVehicleCreate(
  client: ApiClient,
  fields: VehicleWriteFields,
  flags: WriteFlags
): Promise<unknown> {
  const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken());
  if (flags.dryRun) {
    return client.post(
      `/api/vehicle/new/${ownerAsiakasId}`,
      {},
      { headers: writeFlagsToHeaders(flags) }
    );
  }
  const created = await client.post<{ vehicleId: number }>(
    `/api/vehicle/new/${ownerAsiakasId}`,
    {},
    { headers: writeFlagsToHeaders({ reason: flags.reason }) }
  );
  const body = {
    vehicleId: created.vehicleId,
    asiakasId: fields.asiakasId ?? ownerAsiakasId,
    vehicleNo: fields.vehicleNo ?? null,
    vehicleNimi: fields.vehicleNimi ?? null,
    vehicleRegNo: fields.vehicleRegNo ?? null,
    vehicleTypeId: fields.vehicleTypeId ?? null,
    memo: fields.memo ?? null,
    defaultKuski_personId: fields.defaultKuski_personId ?? null,
    vehicleM3: fields.vehicleM3 ?? null,
  };
  return client.post("/api/vehicle/save", body, {
    headers: writeFlagsToHeaders({
      idempotencyKey: flags.idempotencyKey,
      reason: flags.reason,
    }),
  });
}

/**
 * Register `ib vehicle` subcommands on the parent commander instance:
 *   - list     filterable by --limit/--cursor
 *   - get      single vehicle by id
 *   - status   current driver + keikka + live GPS ping
 *   - drivers  driver-assignment history, filterable by --from/--to
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerVehicleCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const v = parent.command("vehicle").description("Vehicle commands");

  v.command("list")
    .description("List vehicles")
    .option("--limit <n>", "Max rows", (val: string) => Math.min(Number(val), 500))
    .option("--cursor <c>", "Pagination cursor")
    .action(async (opts: VehicleListFilter) => {
      try {
        const client = await getClient();
        const result = await runVehicleList(client, opts);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("get <vehicleId>")
    .description("Get a single vehicle by vehicleId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runVehicleGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("status <vehicleId>")
    .description("Current driver, keikka, and latest GPS ping for a vehicle")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runVehicleStatus(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("drivers <vehicleId>")
    .description("Driver-assignment history for a vehicle within a date range")
    .option("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .option("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
    .action(async (idStr: string, opts: VehicleDriversFilter) => {
      try {
        const client = await getClient();
        const result = await runVehicleDrivers(client, Number(idStr), {
          from: resolveDate(opts.from),
          to: resolveDate(opts.to),
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("types")
    .description("List vehicle types (vehicleTypeId + name)")
    .action(async () => {
      try {
        writeJson(await runVehicleTypes(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  v.command("search <query>")
    .description("Search vehicles by reg-no / name substring")
    .option("--limit <n>", "Max rows", (val: string) =>
      Math.min(Number(val), 500)
    )
    .action(async (query: string, opts: { limit?: number }) => {
      try {
        writeJson(await runVehicleSearch(await getClient(), query, opts.limit));
      } catch (e) {
        exitWithError(e);
      }
    });

  const createCmd = v
    .command("create")
    .description("Create a vehicle (new stub then save). ownerAsiakasId from JWT.")
    .option("--reg <s>", "Registration number (vehicleRegNo)")
    .option("--name <s>", "Display name (vehicleNimi)")
    .option("--no <n>", "Fleet number (vehicleNo)", (s: string) => Number(s))
    .option("--type <n>", "vehicleTypeId (see `ib vehicle types`)", (s: string) =>
      Number(s)
    )
    .option("--memo <s>", "Free-text memo")
    .option("--default-driver <pid>", "Default driver personId", (s: string) =>
      Number(s)
    )
    .option(
      "--capacity <m3>",
      "Concrete capacity in m3 (vehicleM3)",
      (s: string) => Number(s)
    )
    .option(
      "--asiakas <id>",
      "Owning asiakasId (defaults to active company)",
      (s: string) => Number(s)
    );
  addWriteFlagsToCommand(createCmd).action(
    async (
      opts: WriteFlags & {
        reg?: string;
        name?: string;
        no?: number;
        type?: number;
        memo?: string;
        defaultDriver?: number;
        capacity?: number;
        asiakas?: number;
      }
    ) => {
      try {
        const result = await runVehicleCreate(
          await getClient(),
          {
            vehicleRegNo: opts.reg,
            vehicleNimi: opts.name,
            vehicleNo: opts.no,
            vehicleTypeId: opts.type,
            memo: opts.memo,
            defaultKuski_personId: opts.defaultDriver,
            vehicleM3: opts.capacity,
            asiakasId: opts.asiakas,
          },
          {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
          }
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
