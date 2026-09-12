import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { addJsonBodyOptions } from "../_shared/jsonBody.js";
import { intFlag } from "../../targets.js";
import { guarded } from "../_shared/action.js";

/** Typed convenience fields for `palkki-type create`, mapped to backend body keys. */
export interface PalkkiTypeCreateFields {
  name?: string;
  description?: string;
  owner?: number;
  active?: boolean;
  vehicleAvailable?: boolean;
  sortNo?: number;
  showReportKlo?: boolean;
  reportStyle?: string;
  showInReport?: boolean;
  isInventoryTransfer?: boolean;
  isJob?: boolean;
}

/**
 * Merge typed convenience flags over a parsed --body object (typed flags win).
 * Maps to the POST /grid/palkkiType/new body shape.
 */
export function buildPalkkiTypeCreateBody(
  parsedBody: Record<string, unknown>,
  typed: PalkkiTypeCreateFields
): Record<string, unknown> {
  const body = { ...parsedBody };
  if (typed.name !== undefined) body.name = typed.name;
  if (typed.description !== undefined) body.unit = typed.description;
  if (typed.owner !== undefined) body.ownerAsiakasId = typed.owner;
  if (typed.active !== undefined) body.isActive = typed.active;
  if (typed.vehicleAvailable !== undefined) body.vehicleAvailable = typed.vehicleAvailable;
  if (typed.sortNo !== undefined) body.sortNo = typed.sortNo;
  if (typed.showReportKlo !== undefined) body.showReportKlo = typed.showReportKlo;
  if (typed.reportStyle !== undefined) body.reportStyle = typed.reportStyle;
  if (typed.showInReport !== undefined) body.showInReport = typed.showInReport;
  if (typed.isInventoryTransfer !== undefined) body.isInventoryTransfer = typed.isInventoryTransfer;
  if (typed.isJob !== undefined) body.isJob = typed.isJob;
  return body;
}

/**
 * POST /grid/palkkiType/new. `body.name` is REQUIRED (the backend falls back
 * to a placeholder name otherwise, which is never what a caller wants) —
 * checked here so the failure is a clear exit 4 instead of a silently wrong row.
 */
export async function runPalkkiTypeCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  if (typeof body.name !== "string" || !body.name.trim()) {
    failWith("create requires: --name (grid_palkkiType)", 4);
  }
  return client.post<unknown>("/api/grid/palkkiType/new", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Register `ib grid` subcommands.
 *
 *   palkki-type create   POST /grid/palkkiType/new — required --name;
 *                         --owner defaults to the active company (owner 0,
 *                         the shared/global catalog every company inherits,
 *                         requires sysadmin/developer). Typed flags or --body
 *                         JSON; typed flags win.
 *
 * `list`/`update`/`delete` are deliberately NOT implemented yet — the only
 * existing read route (GET /grid/getStaticData/:ownerAsiakasId) ignores its
 * own :ownerAsiakasId path param and always answers for the CALLER's active
 * company, so it cannot list another tenant's types without a backend fix
 * first (tracked via `ib dev feedback`).
 */
export function registerGridCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const g = parent.command("grid").description("Grid (day-schedule) reference data commands");
  const pt = g.command("palkki-type").description("Palkki type (grid bar/annotation category) commands");

  const createCmd = addJsonBodyOptions(pt.command("create"))
    .option("--name <n>", "grid_palkkiType (REQUIRED)")
    .option("--description <d>", "grid_palkkiTypeDescription")
    .option("--owner <id>", "Owning ownerAsiakasId (defaults to active company; 0 = the shared/global catalog, sysadmin/developer only)", intFlag("--owner", 0))
    .option("--inactive", "Create as active=false (default: active)")
    .option("--vehicle-available", "vehicleAvailable = true (default)")
    .option("--vehicle-unavailable", "vehicleAvailable = false")
    .option("--sort-no <n>", "Explicit sortNo (default: MAX(sortNo)+10)", intFlag("--sort-no", 0))
    .option("--show-report-time", "showReportKlo = true (default)")
    .option("--hide-report-time", "showReportKlo = false")
    .option("--report-style <css>", "reportStyle — a raw CSS-in-JS fragment applied to the grid bar, e.g. 'fontWeight: \"bold\",'")
    .option("--show-in-report", "showInReport = true (default)")
    .option("--hide-in-report", "showInReport = false")
    .option("--inventory-transfer", "isInventoryTransfer = true (default: false) — a palkki of this type auto-creates a delivery record")
    .option("--job", "isJob = true (default: false)");
  addWriteFlagsToCommand(createCmd).action(
    guarded(async (opts: WriteFlags & {
      body?: string;
      fromJson?: string;
      name?: string;
      description?: string;
      owner?: number;
      inactive?: boolean;
      vehicleAvailable?: boolean;
      vehicleUnavailable?: boolean;
      sortNo?: number;
      showReportTime?: boolean;
      hideReportTime?: boolean;
      reportStyle?: string;
      showInReport?: boolean;
      hideInReport?: boolean;
      inventoryTransfer?: boolean;
      job?: boolean;
    }) => {
      if (opts.vehicleAvailable && opts.vehicleUnavailable) {
        failWith("Pass at most one of --vehicle-available / --vehicle-unavailable", 4);
      }
      if (opts.showReportTime && opts.hideReportTime) {
        failWith("Pass at most one of --show-report-time / --hide-report-time", 4);
      }
      if (opts.showInReport && opts.hideInReport) {
        failWith("Pass at most one of --show-in-report / --hide-in-report", 4);
      }
      const client = await getClient();
      const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
      const owner = opts.owner !== undefined ? opts.owner : await resolveActiveOwnerAsiakasId(client, "pass --owner");
      const body = buildPalkkiTypeCreateBody(parsed, {
        name: opts.name,
        description: opts.description,
        owner,
        active: opts.inactive ? false : undefined,
        vehicleAvailable: opts.vehicleAvailable ? true : opts.vehicleUnavailable ? false : undefined,
        sortNo: opts.sortNo,
        showReportKlo: opts.showReportTime ? true : opts.hideReportTime ? false : undefined,
        reportStyle: opts.reportStyle,
        showInReport: opts.showInReport ? true : opts.hideInReport ? false : undefined,
        isInventoryTransfer: opts.inventoryTransfer ? true : undefined,
        isJob: opts.job ? true : undefined,
      });
      writeJson(await runPalkkiTypeCreate(client, body, opts));
    })
  );
}
