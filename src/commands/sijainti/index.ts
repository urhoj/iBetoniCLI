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
 * Sentinel `jerryActiveUntil` value meaning "enrolled in BetoniJerry, no end
 * date" — matches the EditSijainti toggle (a future/sentinel datetime = active,
 * NULL = not enrolled). See sijainti.jerryActiveUntil in geoCodeSql.js.
 */
const JERRY_ACTIVE_SENTINEL = "9999-12-31 23:59:59";

export interface SijaintiListFilter {
  type?: string;
  limit?: number;
}

/**
 * GET /api/cli/sijainti/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runSijaintiList(
  client: ApiClient,
  opts: SijaintiListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/sijainti/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/geocode/sijainti/get/:sijaintiId — existing geocode route (not
 * /api/cli/) reused for v1.0 reads. Returns the flat backend record as-is.
 */
export async function runSijaintiGet(
  client: ApiClient,
  sijaintiId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/geocode/sijainti/get/${sijaintiId}`
  );
}

/**
 * POST /api/geocode/sijainti/add with a free-form body forwarded to the
 * existing BE endpoint. Write flags surface as the universal `X-Dry-Run` /
 * `Idempotency-Key` / `X-Action-Reason` headers.
 */
export async function runSijaintiCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/geocode/sijainti/add", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * POST /api/geocode/updateSijainti with a free-form body. The target
 * `sijaintiId` is carried IN the body (not the URL) — this matches the
 * existing geocodeRoutes.js shape.
 */
export async function runSijaintiUpdate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/geocode/updateSijainti", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Toggle a varikko's BetoniJerry enrolment by writing `jerryActiveUntil`. There
 * is no partial-update route, so this replicates the EditSijainti save: GET the
 * current row, override `jerryActiveUntil` (sentinel = on, null = off), and POST
 * it back through /api/geocode/updateSijainti. `updateSijainti` whitelists the
 * persisted fields via extractSijaintiBody (lat/lng/placeId are untouched by
 * sijainti_save), so the round-trip preserves the rest of the row. `--dry-run`
 * is honoured server-side (the route returns `wouldUpdate` without persisting).
 */
export async function runSijaintiSetJerry(
  client: ApiClient,
  sijaintiId: number,
  on: boolean,
  flags: WriteFlags
): Promise<unknown> {
  const current = await client.get<Record<string, unknown>>(
    `/api/geocode/sijainti/get/${sijaintiId}`
  );
  const body = {
    ...current,
    sijaintiId,
    jerryActiveUntil: on ? JERRY_ACTIVE_SENTINEL : null,
  };
  return client.post<unknown>("/api/geocode/updateSijainti", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * DELETE /api/geocode/sijainti/delete/:sijaintiId — soft-delete (sets
 * deletedTime). Server-side gate: validateSijaintiWriteAccess. Write flags
 * surface as the universal headers; --reason is enforced at the CLI layer.
 */
export async function runSijaintiDelete(
  client: ApiClient,
  sijaintiId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete(`/api/geocode/sijainti/delete/${sijaintiId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * POST /api/geocode/sijainti/undelete/:sijaintiId — restore a soft-deleted
 * sijainti. Empty body; same write gate as delete.
 */
export async function runSijaintiUndelete(
  client: ApiClient,
  sijaintiId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    `/api/geocode/sijainti/undelete/${sijaintiId}`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

export interface SijaintiTypeItem {
  sijaintiTypeId: number;
  selite: string | null;
}

/**
 * GET /api/geocode/sijaintiTypes — the "Sijainnin laji" lookup. Projects the
 * backend `{sijaintiTypeId, sijaintiTypeSelite}` rows into the universal list
 * envelope with a tidy `selite` field. `--jerry` switches to the BetoniJerry
 * type set (useJerry=1).
 */
export async function runSijaintiTypes(
  client: ApiClient,
  useJerry?: boolean
): Promise<ListEnvelope<SijaintiTypeItem>> {
  const rows = await client.get<
    Array<{ sijaintiTypeId: number; sijaintiTypeSelite?: string | null }>
  >(`/api/geocode/sijaintiTypes${useJerry ? "?useJerry=1" : ""}`);
  const items = (rows || []).map((r) => ({
    sijaintiTypeId: r.sijaintiTypeId,
    selite: r.sijaintiTypeSelite ?? null,
  }));
  return { items, nextCursor: null, count: items.length };
}

/**
 * POST /api/geocode/getLatLng — geocode a free-form address string to
 * coordinates via Google Maps. The backend derives ownerAsiakasId from the
 * token. Returns the raw Google geocode result verbatim (shape:
 * `{ status, lat, lng, ... }`; `{ status: "ZERO_RESULTS" }` when the address
 * is shorter than 5 characters or has no match). Read-only, no write flags.
 */
export async function runSijaintiGeocode(
  client: ApiClient,
  address: string
): Promise<unknown> {
  return client.post<unknown>("/api/geocode/getLatLng", { osoite: address });
}

/**
 * Resolve the caller's active ownerAsiakasId via the existing
 * /api/company-selection/available route. Used by closest/distance, whose
 * legacy geocode routes still take asiakasId as a URL positional.
 */
async function resolveOwnerAsiakasId(client: ApiClient): Promise<number> {
  const available = await client.get<{ currentCompanyId: number }>(
    "/api/company-selection/available"
  );
  return available.currentCompanyId;
}

export interface SijaintiClosestFilter {
  tyomaaId: number;
  sijaintiTypeId: number;
  asiakasId?: number;
}

/**
 * GET /api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa — nearest
 * sijainti of the given type to a worksite (straight-line / Haversine).
 *
 * The legacy route path carries a `:sijaintiId` segment the handler IGNORES —
 * we pass `0`. asiakasId defaults to the caller's active company. The raw
 * response is a createSuccessResponse envelope (matkaM/min/timestamp noise);
 * we project to just `{ closestSijainti, closestDistance }`.
 */
export async function runSijaintiClosest(
  client: ApiClient,
  opts: SijaintiClosestFilter
): Promise<{ closestSijainti: unknown; closestDistance: number | null }> {
  const asiakasId = opts.asiakasId ?? (await resolveOwnerAsiakasId(client));
  const raw = await client.get<{
    closestSijainti?: unknown;
    closestDistance?: number;
  }>(
    `/api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa/${opts.tyomaaId}/0/${opts.sijaintiTypeId}/${asiakasId}`
  );
  return {
    closestSijainti: raw.closestSijainti ?? null,
    closestDistance: raw.closestDistance ?? null,
  };
}

/**
 * Register `ib sijainti` subcommands on the parent commander instance:
 *   - list    filterable by --type/--limit
 *   - get     single sijainti by id (uses existing /api/geocode/sijainti route)
 *   - create  POST /api/geocode/sijainti/add with --body JSON (write flags)
 *   - update  POST /api/geocode/updateSijainti with --body JSON (sijaintiId
 *             must be present IN the body; the route reads it from the body,
 *             not the URL)
 *
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerSijaintiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const s = parent.command("sijainti").description("Sijainti (location) commands");

  s.command("list")
    .description("List sijainti (locations)")
    .option("--type <t>", "Filter by sijainti type")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .action(async (opts: SijaintiListFilter) => {
      try {
        const client = await getClient();
        const result = await runSijaintiList(client, opts);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  s.command("get <sijaintiId>")
    .description("Get a single sijainti by sijaintiId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runSijaintiGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  const createCmd = s
    .command("create")
    .description("Create a new sijainti (POST /api/geocode/sijainti/add)")
    .requiredOption(
      "--body <json>",
      "JSON object forwarded verbatim as the request body"
    );
  addWriteFlagsToCommand(createCmd).action(
    async (opts: {
      body: string;
      dryRun?: boolean;
      idempotencyKey?: string;
      reason?: string;
    }) => {
      try {
        const client = await getClient();
        const parsed = JSON.parse(opts.body) as Record<string, unknown>;
        const result = await runSijaintiCreate(client, parsed, {
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

  const updateCmd = s
    .command("update")
    .description(
      "Update a sijainti (POST /api/geocode/updateSijainti; sijaintiId is in the body)"
    )
    .requiredOption(
      "--body <json>",
      "JSON object forwarded verbatim as the request body (must include sijaintiId)"
    );
  addWriteFlagsToCommand(updateCmd).action(
    async (opts: {
      body: string;
      dryRun?: boolean;
      idempotencyKey?: string;
      reason?: string;
    }) => {
      try {
        const client = await getClient();
        const parsed = JSON.parse(opts.body) as Record<string, unknown>;
        const result = await runSijaintiUpdate(client, parsed, {
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

  const setJerryCmd = s
    .command("set-jerry <sijaintiId>")
    .description(
      "Enrol/unenrol a varikko in BetoniJerry by setting jerryActiveUntil (--on/--off)"
    )
    .option("--on", "Enrol: jerryActiveUntil = sentinel (varikko receives Jerry requests)")
    .option("--off", "Unenrol: jerryActiveUntil = null");
  addWriteFlagsToCommand(setJerryCmd).action(
    async (
      idStr: string,
      opts: {
        on?: boolean;
        off?: boolean;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
      }
    ) => {
      if (opts.on === opts.off) {
        // neither or both given — ambiguous
        writeError(new Error("Pass exactly one of --on / --off"));
        process.exit(4);
      }
      try {
        const client = await getClient();
        const result = await runSijaintiSetJerry(client, Number(idStr), !!opts.on, {
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

  addWriteFlagsToCommand(
    s
      .command("delete <sijaintiId>")
      .description(
        "Soft-delete a sijainti (DELETE /api/geocode/sijainti/delete/:id). Requires --reason."
      )
  ).action(async (idStr: string, opts: WriteFlags) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runSijaintiDelete(client, Number(idStr), opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    s
      .command("undelete <sijaintiId>")
      .description(
        "Restore a soft-deleted sijainti (POST /api/geocode/sijainti/undelete/:id). Requires --reason."
      )
  ).action(async (idStr: string, opts: WriteFlags) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runSijaintiUndelete(client, Number(idStr), opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  s.command("types")
    .description(
      "List sijainti type categories (the 'Sijainnin laji' lookup; maps sijaintiTypeId → selite)"
    )
    .option("--jerry", "Use the BetoniJerry sijainti type set")
    .action(async (opts: { jerry?: boolean }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiTypes(client, opts.jerry);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  s.command("geocode")
    .description(
      "Geocode an address string to coordinates (POST /api/geocode/getLatLng, Google Maps)"
    )
    .requiredOption("--address <a>", "Free-form address to geocode")
    .action(async (opts: { address: string }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiGeocode(client, opts.address);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  s.command("closest")
    .description(
      "Find the closest sijainti of a given type to a worksite (straight-line distance)"
    )
    .requiredOption("--tyomaa <id>", "Target tyomaaId", Number)
    .requiredOption("--type <id>", "sijaintiTypeId to search within", Number)
    .option("--asiakas <id>", "Owner asiakasId (defaults to active company)", Number)
    .action(async (opts: { tyomaa: number; type: number; asiakas?: number }) => {
      try {
        const client = await getClient();
        const result = await runSijaintiClosest(client, {
          tyomaaId: opts.tyomaa,
          sijaintiTypeId: opts.type,
          asiakasId: opts.asiakas,
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });
}
