import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";

export interface WorksiteListFilter {
  limit?: number;
  cursor?: string;
}

/**
 * GET /api/cli/worksite/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runWorksiteList(
  client: ApiClient,
  opts: WorksiteListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/worksite/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/worksite/get/:tyomaaId. Returns the flat backend record as-is.
 */
export async function runWorksiteGet(
  client: ApiClient,
  tyomaaId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/worksite/get/${tyomaaId}`
  );
}

/**
 * POST /api/tyomaa/search — existing (non-/api/cli/) route used by the FE
 * worksite typeahead. Body is `{ searchString: <query> }`. The backend scopes
 * results to the caller's company (req.user.ownerAsiakasId) when no
 * ownerAsiakasId is in the body, so the CLI sends only searchString. Result
 * shape is whatever the backend returns (typically an array of tyomaa records).
 */
export async function runWorksiteSearch(
  client: ApiClient,
  query: string
): Promise<unknown> {
  return client.post<unknown>("/api/tyomaa/search", { searchString: query });
}

/**
 * POST /api/tyomaa/new with a free-form body forwarded to the existing BE
 * endpoint (FE: `tyomaa_save_to_db()`). Write flags surface as the universal
 * `X-Dry-Run` / `Idempotency-Key` / `X-Action-Reason` headers.
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - `ownerAsiakasId` is required (validateRequiredFields).
 *   - `tyomaaContactPersonId` has a NOT NULL constraint; pass `0` for
 *     "no contact assigned".
 */
export async function runWorksiteCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/tyomaa/new", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Format today's date as YYYYMMDD (no separators), in local time. Used as the
 * default `yyyymmdd` URL segment for /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd
 * when the caller doesn't supply one.
 */
function todayYyyymmdd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * POST /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd with a free-form
 * body. `ownerAsiakasId` comes from the caller's credentials context and must
 * be passed in by the action wiring. `yyyymmdd` defaults to today in local
 * time (YYYYMMDD, no separators).
 *
 * Body shape pitfall verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - The handler runs `validateRequiredFields(body, ["tyomaaId", "ownerAsiakasId"])`,
 *     so both ids must be present in the BODY (not just the URL). We inject them
 *     from `opts` so callers only need to put the fields-to-update in `--body`.
 */
export async function runWorksiteUpdate(
  client: ApiClient,
  opts: { tyomaaId: number; ownerAsiakasId: number; yyyymmdd?: string },
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  const yyyymmdd = opts.yyyymmdd || todayYyyymmdd();
  // Inject the backend-required ids; the URL/derived ids are authoritative
  // (they override anything in --body), so the caller's body need only carry
  // the fields to change.
  const fullBody = {
    ...body,
    tyomaaId: opts.tyomaaId,
    ownerAsiakasId: opts.ownerAsiakasId,
  };
  return client.post<unknown>(
    `/api/tyomaa/set/${opts.ownerAsiakasId}/${opts.tyomaaId}/${yyyymmdd}`,
    fullBody,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * GET /api/cli/worksite/metrics/:tyomaaId — volume / keikka-count summary plus
 * monthly breakdown. Owner derived from the JWT server-side.
 */
export async function runWorksiteMetrics(
  client: ApiClient,
  tyomaaId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/worksite/metrics/${tyomaaId}`
  );
}

/** GET /api/cli/worksite/dates/:tyomaaId — a worksite's compliance dates. */
export async function runWorksiteDatesList(
  client: ApiClient,
  tyomaaId: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/worksite/dates/${tyomaaId}`
  );
}

/** GET /api/cli/worksite/dates/expiring?days=N — company-wide expiry feed. */
export async function runWorksiteDatesExpiring(
  client: ApiClient,
  days: number | undefined
): Promise<ListEnvelope<Record<string, unknown>>> {
  const d = days !== undefined ? days : 30;
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/worksite/dates/expiring?days=${d}`
  );
}

/** POST /api/tyomaa/refreshLocation/:tyomaaId — re-geocode from Google Maps. */
export async function runWorksiteRefreshLocation(
  client: ApiClient, tyomaaId: number, flags: WriteFlags
): Promise<unknown> {
  return client.post(`/api/tyomaa/refreshLocation/${tyomaaId}`, {}, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** POST /api/tyomaa/:tyomaaId/geofence-radius — set geofence radius (1-10000 m). */
export async function runWorksiteSetGeofence(
  client: ApiClient, tyomaaId: number, radius: number, flags: WriteFlags
): Promise<unknown> {
  return client.post(`/api/tyomaa/${tyomaaId}/geofence-radius`, { geofenceRadius: radius }, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** POST /api/tyomaa/helsinki/fetch/:tyomaaId — refresh Helsinki building data. */
export async function runWorksiteHelsinkiFetch(
  client: ApiClient, tyomaaId: number, flags: WriteFlags
): Promise<unknown> {
  return client.post(`/api/tyomaa/helsinki/fetch/${tyomaaId}`, {}, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * DELETE /api/tyomaa/delete/:tyomaaId. Universal write flags surface as
 * headers; `--reason` is enforced by the CLI layer.
 */
export async function runWorksiteDelete(
  client: ApiClient,
  tyomaaId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete(
    `/api/tyomaa/delete/${tyomaaId}`,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * Derive the active company's ownerAsiakasId from the client's JWT. Used by
 * `worksite update` so the CLI no longer asks for --owner-asiakas-id. Throws a
 * clean Error when the token carries no usable owner claim; the command action
 * routes it through exitWithError (generic exit 1).
 */
export function resolveOwnerAsiakasId(client: ApiClient): number {
  const token = client.getCurrentToken();
  const owner = token ? decodeJwtPayload(token).ownerAsiakasId : NaN;
  if (!Number.isFinite(owner) || owner < 1) {
    throw new Error("Could not derive ownerAsiakasId from the active session token");
  }
  return owner;
}

/**
 * Shape of the request body for both `worksite person add` and
 * `worksite person remove`. `contactPersonTypeId` defaults to 1 on the CLI
 * surface (matches FE default for tyomaaPerson links).
 */
export interface WorksitePersonLinkBody {
  tyomaaId: number;
  personId: number;
  contactPersonTypeId: number;
}

/**
 * POST /api/tyomaa/person/add — attach a person to a worksite.
 * Forwards the universal write-flag headers.
 */
export async function runWorksitePersonAdd(
  client: ApiClient,
  body: WorksitePersonLinkBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/tyomaa/person/add",
    body,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /api/tyomaa/person/remove — detach a person from a worksite.
 * Forwards the universal write-flag headers.
 */
export async function runWorksitePersonRemove(
  client: ApiClient,
  body: WorksitePersonLinkBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/tyomaa/person/remove",
    body,
    { headers: writeFlagsToHeaders(flags) }
  );
}

interface WorksitePersonRow {
  personId: number;
  personFirstName?: string;
  personLastName?: string;
  personEmail?: string;
  contactPersonTypeId?: number;
}

export interface WorksitePersonListItem {
  personId: number;
  name: string;
  email: string | null;
  contactType: number | null;
}

/**
 * GET /api/tyomaa/person/list/:tyomaaId/0 — returns persons attached to a
 * worksite. The second URL segment is a typeId placeholder (the FE / BE
 * route shape mirrors `asiakas/person/list`); we always pass `0` because
 * tyomaaPerson links don't have a per-role filter. The flat backend array is
 * wrapped in the universal `ListEnvelope` so output formatters can render it.
 */
export async function runWorksitePersonList(
  client: ApiClient,
  tyomaaId: number
): Promise<ListEnvelope<WorksitePersonListItem>> {
  const rows = await client.get<WorksitePersonRow[]>(
    `/api/tyomaa/person/list/${tyomaaId}/0`
  );
  const items = (rows || []).map((r) => ({
    personId: r.personId,
    name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
    email: r.personEmail || null,
    contactType: r.contactPersonTypeId || null,
  }));
  return { items, nextCursor: null, count: items.length };
}

/**
 * Register `ib worksite` subcommands on the parent commander instance:
 *   - list            filterable by --limit/--cursor
 *   - get             single tyomaa by id
 *   - metrics         GET /api/cli/worksite/metrics/:id (volume/keikka counts)
 *   - dates list      GET /api/cli/worksite/dates/:id (compliance dates, read-only)
 *   - dates expiring  GET /api/cli/worksite/dates/expiring?days=N (read-only)
 *   - search          free-text search (existing POST /api/tyomaa/search route)
 *   - create          POST /api/tyomaa/new with --body JSON (write flags)
 *   - update          POST /api/tyomaa/set/<ownerAsiakasId>/<tyomaaId>/<yyyymmdd>
 *   - delete          DELETE /api/tyomaa/delete/:id (write flags, --reason)
 *   - refresh-location POST /api/tyomaa/refreshLocation/:id (write flags)
 *   - set-geofence    POST /api/tyomaa/:id/geofence-radius (write flags)
 *   - helsinki-fetch  POST /api/tyomaa/helsinki/fetch/:id (write flags)
 *   - person add/remove/list  tyomaaPerson link management
 *
 * The `update` action derives ownerAsiakasId from the session JWT via
 * `resolveOwnerAsiakasId` — no --owner-asiakas-id flag required.
 * `--yyyymmdd` defaults to today.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerWorksiteCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const w = parent.command("worksite").description("Worksite commands");

  w.command("list")
    .description("List worksites")
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .option("--cursor <c>", "Pagination cursor")
    .action(async (opts: WorksiteListFilter) => {
      try {
        const client = await getClient();
        const result = await runWorksiteList(client, opts);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  w.command("get <tyomaaId>")
    .description("Get a single worksite by tyomaaId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runWorksiteGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  w.command("metrics <tyomaaId>")
    .description("Volume / keikka-count metrics for a worksite")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runWorksiteMetrics(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  const dates = w.command("dates").description("Worksite compliance dates (read-only)");
  dates
    .command("list <tyomaaId>")
    .description("List a worksite's compliance/permit dates")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        writeJson(await runWorksiteDatesList(client, Number(idStr)));
      } catch (e) {
        exitWithError(e);
      }
    });
  dates
    .command("expiring")
    .description("Company-wide expiring worksite dates")
    .option("--days <n>", "Look-ahead window in days (default 30)", (v: string) => Number(v))
    .action(async (opts: { days?: number }) => {
      try {
        const client = await getClient();
        writeJson(await runWorksiteDatesExpiring(client, opts.days));
      } catch (e) {
        exitWithError(e);
      }
    });

  w.command("search <query>")
    .description("Free-text search for worksites")
    .action(async (query: string) => {
      try {
        const client = await getClient();
        const result = await runWorksiteSearch(client, query);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  const createCmd = w
    .command("create")
    .description("Create a new worksite (POST /api/tyomaa/new)")
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
        const result = await runWorksiteCreate(client, parsed, {
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

  const updateCmd = w
    .command("update <tyomaaId>")
    .description("Update a worksite (owner auto-derived from the session)")
    .requiredOption(
      "--body <json>",
      "JSON object forwarded verbatim as the request body"
    )
    .option("--yyyymmdd <date>", "Date segment YYYYMMDD (defaults to today)");
  addWriteFlagsToCommand(updateCmd).action(
    async (
      idStr: string,
      opts: {
        body: string;
        yyyymmdd?: string;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
      }
    ) => {
      try {
        const client = await getClient();
        const ownerAsiakasId = resolveOwnerAsiakasId(client);
        const parsed = JSON.parse(opts.body) as Record<string, unknown>;
        const result = await runWorksiteUpdate(
          client,
          { tyomaaId: Number(idStr), ownerAsiakasId, yyyymmdd: opts.yyyymmdd },
          parsed,
          { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    w
      .command("delete <tyomaaId>")
      .description("Delete a worksite (tyomaa). Requires --reason.")
  ).action(async (tyomaaIdStr: string, opts: WriteFlags) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runWorksiteDelete(client, Number(tyomaaIdStr), opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    w.command("refresh-location <tyomaaId>")
      .description("Re-geocode a worksite from Google Maps")
  ).action(async (idStr: string, opts: WriteFlags) => {
    try {
      const client = await getClient();
      writeJson(await runWorksiteRefreshLocation(client, Number(idStr), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    w.command("set-geofence <tyomaaId>")
      .description("Set a worksite geofence radius in metres (1-10000)")
      .requiredOption("--radius <m>", "Geofence radius in metres", Number)
  ).action(async (idStr: string, opts: WriteFlags & { radius: number }) => {
    if (!Number.isInteger(opts.radius) || opts.radius < 1 || opts.radius > 10000) {
      writeError(new Error("--radius must be an integer between 1 and 10000"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      writeJson(await runWorksiteSetGeofence(client, Number(idStr), opts.radius, opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    w.command("helsinki-fetch <tyomaaId>")
      .description("Refresh Helsinki building data for a worksite")
  ).action(async (idStr: string, opts: WriteFlags) => {
    try {
      const client = await getClient();
      writeJson(await runWorksiteHelsinkiFetch(client, Number(idStr), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  const worksitePerson = w
    .command("person")
    .description("Manage persons attached to a worksite");

  addWriteFlagsToCommand(
    worksitePerson
      .command("add")
      .description("Attach a person to a worksite (tyomaaPerson). Requires --reason.")
      .requiredOption("--worksite <id>", "Target tyomaaId", Number)
      .requiredOption("--person <id>", "Target personId", Number)
      .option("--contact-type <id>", "contactPersonTypeId (default 1)", Number, 1)
  ).action(async (opts: WriteFlags & { worksite: number; person: number; contactType: number }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runWorksitePersonAdd(
        client,
        { tyomaaId: opts.worksite, personId: opts.person, contactPersonTypeId: opts.contactType },
        opts
      );
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    worksitePerson
      .command("remove")
      .description("Detach a person from a worksite. Requires --reason.")
      .requiredOption("--worksite <id>", "Target tyomaaId", Number)
      .requiredOption("--person <id>", "Target personId", Number)
      .option("--contact-type <id>", "contactPersonTypeId (default 1)", Number, 1)
  ).action(async (opts: WriteFlags & { worksite: number; person: number; contactType: number }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runWorksitePersonRemove(
        client,
        { tyomaaId: opts.worksite, personId: opts.person, contactPersonTypeId: opts.contactType },
        opts
      );
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  worksitePerson
    .command("list <tyomaaId>")
    .description("List persons attached to a worksite.")
    .action(async (tyomaaIdStr: string) => {
      try {
        const client = await getClient();
        const result = await runWorksitePersonList(client, Number(tyomaaIdStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });
}
