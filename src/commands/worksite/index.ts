import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
  requireReason,
} from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { parseJsonBodyFlag, resolveJsonObjectBody } from "../../api/parseBody.js";
import { registerLogAlias } from "../log/index.js";
import { resolveTarget, parseId, resolveSearchQuery, cappedInt } from "../../targets.js";
import {
  runAddressDashboard,
  type AddressDashboardReport,
} from "../_shared/addressDashboard.js";
import {
  runCombinatorDuplicates,
  runCombinatorMerge,
  registerCombinatorCommands,
  type CombinatorMergeOptions,
} from "../_shared/combinator.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";

export interface WorksiteListFilter {
  limit?: number;
  cursor?: string;
  customer?: number;
}

/**
 * GET /api/cli/worksite/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runWorksiteList(
  client: ApiClient,
  opts: WorksiteListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/worksite/list${qs({
      limit: opts.limit,
      cursor: opts.cursor || undefined,
      customer: opts.customer,
    })}`
  );
}

/**
 * GET /api/cli/worksite/get/:tyomaaId. Returns the flat, enriched backend
 * record as-is (every user-relevant field in camelCase; see the spec for the
 * shape). The two heavy JSON blobs are opt-in: `includeBuilding` →
 * `?includeBuilding` (attaches `rakennusData`), `includeCameras` →
 * `?includeCameras` (attaches `cameras[]`). Omitted by default — the lean
 * record still carries `cameraCount` + `hasBuildingData` presence signals.
 */
export async function runWorksiteGet(
  client: ApiClient,
  tyomaaId: number,
  opts: { includeBuilding?: boolean; includeCameras?: boolean } = {}
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/worksite/get/${tyomaaId}${qs({
      includeBuilding: opts.includeBuilding ? "1" : undefined,
      includeCameras: opts.includeCameras ? "1" : undefined,
    })}`
  );
}

/** One raw row from the backend `tyomaa_search_usingFullText_v2` recordset. */
interface WorksiteSearchRow {
  tyomaaId: number;
  tyomaaNimi?: string | null;
  tyomaaNum?: string | null;
  tyomaaOsoite1?: string | null;
  tyomaaOsoite2?: string | null;
  tyomaaOsoite3?: string | null;
  tyomaaOsoite4?: string | null;
  tyomaaAjoOhje?: string | null;
  tyomaaMemo?: string | null;
  formattedAddress?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/** Projected worksite search hit — camelCase, consistent with `worksite get`. */
export interface WorksiteSearchItem {
  tyomaaId: number;
  name: string | null;
  tyomaaNum: string | null;
  address: string | null;
  address2: string | null;
  postalCode: string | null;
  city: string | null;
  formattedAddress: string | null;
  coords: { lat: number; lng: number } | null;
  drivingInstructions: string | null;
  comment: string | null;
}

/**
 * POST /api/tyomaa/search — the existing (non-/api/cli/) route that also backs
 * the FE worksite typeahead. Body is `{ searchString: <query> }`; the backend
 * full-text-matches `searchString` against the worksite NAME, ALL FOUR ADDRESS
 * LINES (street / line 2 / postal code / city), driving instructions, memo,
 * formatted address, worksite number AND the contact person's name / phone /
 * email — so a street fragment finds the worksite. Results are scoped to the
 * caller's company (req.user.ownerAsiakasId) when no ownerAsiakasId is in the
 * body, so the CLI sends only searchString (+ optional limit).
 *
 * When `myCompanies` is true, adds `myCompanies: true` to the body so the
 * backend fans out across all companies the caller belongs to (rows tagged with
 * `ownerAsiakasId`).
 *
 * Sent as a `read` request: search is a tenant-scoped non-mutating POST, so
 * `read:true` exempts it from the `--read-only` write-lock and the acting-as
 * write diagnostic (it neither creates nor updates tenant data). Distinct from
 * `meta` (which is for non-tenant diagnostics such as `ib feedback`). The raw
 * Finnish-named recordset is projected into the universal `ListEnvelope` with
 * the same camelCase keys as `worksite get` for a consistent AI-facing shape.
 */
export async function runWorksiteSearch(
  client: ApiClient,
  query: string,
  limit?: number,
  myCompanies = false
): Promise<ListEnvelope<WorksiteSearchItem>> {
  const body: Record<string, unknown> = { searchString: query };
  if (limit !== undefined) body.limit = limit;
  if (myCompanies) body.myCompanies = true;
  const rows = await client.post<WorksiteSearchRow[]>(
    "/api/tyomaa/search",
    body,
    { read: true }
  );
  const items: WorksiteSearchItem[] = (rows || []).map((r) => ({
    tyomaaId: r.tyomaaId,
    name: r.tyomaaNimi || null,
    tyomaaNum: r.tyomaaNum || null,
    address: r.tyomaaOsoite1 || null,
    address2: r.tyomaaOsoite2 || null,
    postalCode: r.tyomaaOsoite3 || null,
    city: r.tyomaaOsoite4 || null,
    formattedAddress: r.formattedAddress || null,
    coords:
      r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null,
    drivingInstructions: r.tyomaaAjoOhje || null,
    comment: r.tyomaaMemo || null,
  }));
  return listEnvelope(items);
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

/** Typed convenience fields for `worksite update`, mapped to backend column names. */
export interface WorksiteUpdateFlags {
  name?: string;
  num?: string;
  address?: string;
  address2?: string;
  postalCode?: string;
  city?: string;
  drivingInstructions?: string;
  comment?: string;
  invoiceRef?: string;
  contactPerson?: number;
}

/**
 * Merge typed update flags over a parsed --body/--from-json patch (typed flags
 * win) into the /api/tyomaa/set patch body. Only fields whose flag was actually
 * provided are included, so any column the caller omitted is left out of the
 * patch — the backend `tyomaa.setData` read-merges omitted columns back to the
 * stored row (an explicit "" still clears). Body keys not covered by a typed
 * flag are preserved untouched. Flag vocabulary mirrors the `worksite get`
 * read projection (name/address/postalCode/city/comment/invoiceRef/…), and
 * matches `customer update` naming. Mirrors buildPersonUpdateBody (fb#234).
 */
export function buildWorksiteUpdateBody(
  parsedBody: Record<string, unknown>,
  typed: WorksiteUpdateFlags
): Record<string, unknown> {
  const body = { ...parsedBody };
  if (typed.name !== undefined) body.tyomaaNimi = typed.name;
  if (typed.num !== undefined) body.tyomaaNum = typed.num;
  if (typed.address !== undefined) body.tyomaaOsoite1 = typed.address;
  if (typed.address2 !== undefined) body.tyomaaOsoite2 = typed.address2;
  if (typed.postalCode !== undefined) body.tyomaaOsoite3 = typed.postalCode;
  if (typed.city !== undefined) body.tyomaaOsoite4 = typed.city;
  if (typed.drivingInstructions !== undefined) body.tyomaaAjoOhje = typed.drivingInstructions;
  if (typed.comment !== undefined) body.tyomaaMemo = typed.comment;
  if (typed.invoiceRef !== undefined) body.laskuViite = typed.invoiceRef;
  if (typed.contactPerson !== undefined) body.tyomaaContactPersonId = typed.contactPerson;
  return body;
}

/**
 * POST /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd with the patch
 * body. `ownerAsiakasId` comes from the caller's credentials context and must
 * be passed in by the action wiring. `yyyymmdd` defaults to today in local
 * time (YYYYMMDD, no separators).
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - The handler runs `validateRequiredFields(body, ["tyomaaId", "ownerAsiakasId"])`,
 *     so both ids must be present in the BODY (not just the URL). We inject them
 *     from `opts` so callers only need to put the fields-to-update in the body.
 *   - Partial-body safety is SERVER-side: `tyomaa.setData` read-merges omitted
 *     columns from the stored row (fb#234; the `tyomaa_save` proc itself
 *     blanket-overwrites every column). DEPLOY-GATED — against a backend
 *     without that merge, a partial body NULLs the omitted columns.
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
  return listEnvelope(items);
}

/**
 * `ib worksite dashboard` — resolve the caller's point from exactly one of
 * `tyomaaId` / `address` and delegate to the shared
 * {@link runAddressDashboard} orchestrator (Address Information Dashboard,
 * spec 2026-07-01): weather, building, cadastral parcel, nearby traffic
 * cameras, nearby sijainnit, worksite deliveries, and nearby vehicles merged
 * into one report. The exactly-one validation is the caller's job (the
 * command action, mirroring `ib opendata building`'s `selectedSources`
 * pattern) — this function just forwards whichever one is set.
 */
export async function runWorksiteDashboard(
  client: ApiClient,
  opts: { tyomaaId?: number; address?: string }
): Promise<AddressDashboardReport> {
  return runAddressDashboard(
    client,
    opts.address !== undefined ? { address: opts.address } : { tyomaaId: opts.tyomaaId }
  );
}

/**
 * Register `ib worksite` subcommands on the parent commander instance:
 *   - list            filterable by --limit/--cursor
 *   - get             single tyomaa by id
 *   - metrics         GET /api/cli/worksite/metrics/:id (volume/keikka counts)
 *   - dates list      GET /api/cli/worksite/dates/:id (compliance dates, read-only)
 *   - dates expiring  GET /api/cli/worksite/dates/expiring?days=N (read-only)
 *   - search          free-text search (existing POST /api/tyomaa/search route)
 *   - dashboard       one-shot Address Information Dashboard report (read-only)
 *   - create          POST /api/tyomaa/new with --body JSON (write flags)
 *   - update          POST /api/tyomaa/set/<ownerAsiakasId>/<tyomaaId>/<yyyymmdd>
 *   - delete          DELETE /api/tyomaa/delete/:id (write flags, --reason)
 *   - refresh-location POST /api/tyomaa/refreshLocation/:id (write flags)
 *   - set-geofence    POST /api/tyomaa/:id/geofence-radius (write flags)
 *   - helsinki-fetch  POST /api/tyomaa/helsinki/fetch/:id (write flags)
 *   - person add/remove/list  tyomaaPerson link management
 *   - duplicates      likely-duplicate worksite pairs for a tenant (read; admin; feeds merge)
 *   - merge           merge two duplicate worksites (--dry-run = /validate; IRREVERSIBLE; requires --reason)
 *
 * The `update` action derives ownerAsiakasId from the session JWT via
 * `ownerAsiakasIdFromToken` — no --owner-asiakas-id flag required.
 * `--yyyymmdd` defaults to today.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
/** tyomaa-combinator request-body id fields (see puminet5api tyomaaCombinatorRoutes). */
const TYOMAA_MERGE_ID_FIELDS = {
  mainField: "mainTyomaaId",
  secondaryField: "secondaryTyomaaId",
} as const;

/**
 * GET /api/admin/tyomaa-combinator/duplicates — likely-duplicate worksite pairs
 * for one tenant (strict name+address+num, or the anonymous same-address cluster).
 * Admin gated server-side. Feeds `ib worksite merge`. See runCombinatorDuplicates.
 */
export function runWorksiteDuplicates(client: ApiClient, ownerAsiakasId: number) {
  return runCombinatorDuplicates(client, "tyomaa-combinator", ownerAsiakasId);
}

/**
 * Merge two duplicate worksites — the secondary's references move onto the main,
 * then the secondary is deleted. IRREVERSIBLE, admin gated. `--dry-run` runs the
 * read-only /validate safety check (works under --read-only). See runCombinatorMerge.
 */
export function runWorksiteMerge(
  client: ApiClient,
  opts: CombinatorMergeOptions,
  flags: WriteFlags
) {
  return runCombinatorMerge(client, "tyomaa-combinator", TYOMAA_MERGE_ID_FIELDS, opts, flags);
}

export function registerWorksiteCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const w = parent.command("worksite").description("Worksite commands");

  w.command("list")
    .option("--limit <n>", "Max rows", cappedInt(500))
    .option("--cursor <c>", "Pagination cursor")
    .option("--customer <n>", "Filter by parent asiakasId", (v: string) => Number(v))
    .action(
      jsonAction(getClient, (client, opts: WorksiteListFilter) =>
        runWorksiteList(client, { limit: opts.limit, cursor: opts.cursor, customer: opts.customer })
      )
    );

  w.command("get <tyomaaId>")
    .option("--include-building", "Attach the parsed Helsinki building data (rakennusData)")
    .option("--include-cameras", "Attach the nearby traffic cameras (cameras[])")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { includeBuilding?: boolean; includeCameras?: boolean }) =>
        runWorksiteGet(client, parseId(idStr, "tyomaaId"), {
          includeBuilding: opts.includeBuilding,
          includeCameras: opts.includeCameras,
        })
      )
    );

  w.command("metrics <tyomaaId>")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runWorksiteMetrics(client, parseId(idStr, "tyomaaId"))
      )
    );

  const dates = w.command("dates").description("Worksite compliance dates (read-only)");
  dates
    .command("list <tyomaaId>")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runWorksiteDatesList(client, parseId(idStr, "tyomaaId"))
      )
    );
  dates
    .command("expiring")
    .option("--days <n>", "Look-ahead window in days (default 30)", (v: string) => Number(v))
    .action(
      jsonAction(getClient, (client, opts: { days?: number }) =>
        runWorksiteDatesExpiring(client, opts.days)
      )
    );

  w.command("search [query]")
    .option("--search <s>", "Search query (alias for the <query> positional)")
    .option("--limit <n>", "Max results", cappedInt(500))
    .option("--my-companies", "Search across every company you belong to (rows tagged with ownerAsiakasId)")
    .action(
      jsonAction(getClient, (client, query: string | undefined, opts: { search?: string; limit?: number; myCompanies?: boolean }) =>
        runWorksiteSearch(client, resolveSearchQuery(query, opts.search), opts.limit, !!opts.myCompanies)
      )
    );

  w.command("dashboard [tyomaaId]")
    .option("--address <address>", "Resolve the point from a street address instead of tyomaaId")
    .action(guarded(async (idStr: string | undefined, opts: { address?: string }) => {
      if (idStr !== undefined && opts.address !== undefined) {
        failWith("pass exactly one of <tyomaaId> or --address, not both", 4);
      }
      if (idStr === undefined && opts.address === undefined) {
        failWith("pass exactly one of <tyomaaId> or --address", 4);
      }
      const tyomaaId = idStr !== undefined ? parseId(idStr, "tyomaaId") : undefined;
      const client = await getClient();
      const result = await runWorksiteDashboard(client, { tyomaaId, address: opts.address });
      writeJson(result);
    }));

  const createCmd = w
    .command("create")
    .requiredOption(
      "--body <json>",
      "JSON object forwarded verbatim as the request body"
    );
  addWriteFlagsToCommand(createCmd).action(
    guarded(async (opts: WriteFlags & { body: string }) => {
      const client = await getClient();
      const parsed = parseJsonBodyFlag(opts.body);
      const result = await runWorksiteCreate(client, parsed, opts);
      writeJson(result);
    })
  );

  const updateCmd = w
    .command("update <tyomaaId>")
    .option("--name <s>", "Worksite name (tyomaaNimi)")
    .option("--num <s>", "Worksite number (tyomaaNum)")
    .option("--address <s>", "Street address (tyomaaOsoite1)")
    .option("--address2 <s>", "Address line 2 (tyomaaOsoite2)")
    .option("--postal-code <s>", "Postal code (tyomaaOsoite3)")
    .option("--city <s>", "City (tyomaaOsoite4)")
    .option("--driving-instructions <s>", "Driving instructions (tyomaaAjoOhje)")
    .option("--comment <s>", "Free-text memo (tyomaaMemo)")
    .option("--invoice-ref <s>", "Invoice reference (laskuViite)")
    .option("--contact-person <id>", "Contact personId (tyomaaContactPersonId; 0 = none)", (v: string) => Number(v))
    .option("--body <json>", "Patch body (JSON), merged under the typed flags")
    .option(
      "--from-json <file>",
      "Read the patch body from a file (or - for stdin) — shell-safe alternative to --body"
    )
    .option("--yyyymmdd <date>", "Date segment YYYYMMDD (defaults to today)");
  addWriteFlagsToCommand(updateCmd).action(
    guarded(async (
      idStr: string,
      opts: WorksiteUpdateFlags & WriteFlags & {
        body?: string;
        fromJson?: string;
        yyyymmdd?: string;
      }
    ) => {
      const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
      const patch = buildWorksiteUpdateBody(parsed, {
        name: opts.name,
        num: opts.num,
        address: opts.address,
        address2: opts.address2,
        postalCode: opts.postalCode,
        city: opts.city,
        drivingInstructions: opts.drivingInstructions,
        comment: opts.comment,
        invoiceRef: opts.invoiceRef,
        contactPerson: opts.contactPerson,
      });
      if (Object.keys(patch).length === 0) {
        failWith(
          "update requires at least one field: typed flags (--name/--num/--address/--address2/--postal-code/--city/--driving-instructions/--comment/--invoice-ref/--contact-person) or a --body/--from-json JSON patch",
          4
        );
      }
      const client = await getClient();
      const ownerAsiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
      const result = await runWorksiteUpdate(
        client,
        { tyomaaId: parseId(idStr, "tyomaaId"), ownerAsiakasId, yyyymmdd: opts.yyyymmdd },
        patch,
        opts
      );
      writeJson(result);
    })
  );

  addWriteFlagsToCommand(
    w
      .command("delete <tyomaaId>")
  ).action(guarded(async (tyomaaIdStr: string, opts: WriteFlags) => {
    requireReason(opts);
    const client = await getClient();
    const result = await runWorksiteDelete(client, parseId(tyomaaIdStr, "tyomaaId"), opts);
    writeJson(result);
  }));

  addWriteFlagsToCommand(w.command("refresh-location <tyomaaId>")).action(
    jsonAction(getClient, (client, idStr: string, opts: WriteFlags) =>
      runWorksiteRefreshLocation(client, parseId(idStr, "tyomaaId"), opts)
    )
  );

  addWriteFlagsToCommand(
    w.command("set-geofence <tyomaaId>")
      .requiredOption("--radius <m>", "Geofence radius in metres", Number)
  ).action(guarded(async (idStr: string, opts: WriteFlags & { radius: number }) => {
    if (!Number.isInteger(opts.radius) || opts.radius < 1 || opts.radius > 10000) {
      failWith("--radius must be an integer between 1 and 10000", 4);
    }
    const client = await getClient();
    writeJson(await runWorksiteSetGeofence(client, parseId(idStr, "tyomaaId"), opts.radius, opts));
  }));

  addWriteFlagsToCommand(w.command("helsinki-fetch <tyomaaId>")).action(
    jsonAction(getClient, (client, idStr: string, opts: WriteFlags) =>
      runWorksiteHelsinkiFetch(client, parseId(idStr, "tyomaaId"), opts)
    )
  );

  const worksitePerson = w
    .command("person")
    .description("Manage persons attached to a worksite");

  addWriteFlagsToCommand(
    worksitePerson
      .command("add")
      .requiredOption("--worksite <id>", "Target tyomaaId", Number)
      .requiredOption("--person <id>", "Target personId", Number)
      .option("--contact-type <id>", "contactPersonTypeId (default 1)", Number, 1)
  ).action(guarded(async (opts: WriteFlags & { worksite: number; person: number; contactType: number }) => {
    requireReason(opts);
    const client = await getClient();
    const result = await runWorksitePersonAdd(
      client,
      { tyomaaId: opts.worksite, personId: opts.person, contactPersonTypeId: opts.contactType },
      opts
    );
    writeJson(result);
  }));

  addWriteFlagsToCommand(
    worksitePerson
      .command("remove")
      .requiredOption("--worksite <id>", "Target tyomaaId", Number)
      .requiredOption("--person <id>", "Target personId", Number)
      .option("--contact-type <id>", "contactPersonTypeId (default 1)", Number, 1)
  ).action(guarded(async (opts: WriteFlags & { worksite: number; person: number; contactType: number }) => {
    requireReason(opts);
    const client = await getClient();
    const result = await runWorksitePersonRemove(
      client,
      { tyomaaId: opts.worksite, personId: opts.person, contactPersonTypeId: opts.contactType },
      opts
    );
    writeJson(result);
  }));

  worksitePerson
    .command("list [tyomaaId]")
    .option("--worksite <id>", "Target tyomaaId (alias for the positional; same flag as person add/remove)", Number)
    .action(
      jsonAction(getClient, (client, tyomaaIdStr: string | undefined, opts: { worksite?: number }) =>
        runWorksitePersonList(
          client,
          resolveTarget(tyomaaIdStr, opts.worksite, "tyomaaId", "worksite")
        )
      )
    );

  registerLogAlias(w, getClient, "tyomaa", "tyomaaId");

  registerCombinatorCommands(w, getClient, {
    base: "tyomaa-combinator",
    idFields: TYOMAA_MERGE_ID_FIELDS,
    entityNoun: "worksite",
    idLabel: "tyomaaId",
  });
}
