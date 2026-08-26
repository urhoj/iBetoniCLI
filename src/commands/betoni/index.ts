/**
 * `ib betoni` — concrete REFERENCE DATA: grades (betoniLaatu), additives
 * (betoniAttr), and the four fixed lookup lists a keikka's concrete spec is
 * built from.
 *
 * Read-only. Both entities have full admin UIs and tenant-scoped write gating,
 * but no CLI surface existed at all, so every "what grades does this supplier
 * have / which are shared / who owns this row" question meant hand-writing
 * node+mssql scripts against the database — six or more times in one session
 * (fb#426). Writes are deliberately out of scope for now: they go through
 * requireBetoniLaatuEdit and carry real cross-tenant risk, and the reported
 * friction was entirely on the read side.
 *
 * THE SHAPE THAT MATTERS: `asiakasId 0` marks the SHARED (yhteinen) grades every
 * tenant sees; anything else is that supplier's own. The backend returns both in
 * one list (`WHERE asiakasId IN (0, <supplier>)`) with no marker, so each row is
 * given an explicit `shared` boolean here rather than leaving every caller to
 * rediscover the sentinel. The same 0-means-shared rule applies to betoniAttr on
 * BOTH its scope columns.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { failUsage } from "../../output/json.js";
import { CliError } from "../../api/errors.js";
import { jsonAction } from "../_shared/action.js";
import { intFlag } from "../../targets.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";

/** The shared-grade / shared-attribute sentinel used by both betoni entities. */
const SHARED_ASIAKAS_ID = 0;

/** One row of dbo.betoniLaatuView, plus the derived `shared` marker. */
export interface BetoniLaatuRow {
  laatuId: number;
  laatuNimike: string | null;
  laatuLyhenne: string | null;
  laatuLaji: string | null;
  laatuSelite: string | null;
  sortNum: number | null;
  asiakasId: number;
  /** True when this is a shared (yhteinen) grade visible to every tenant. */
  shared: boolean;
  isEnabled: boolean | null;
  showInDropDown: boolean | null;
  [k: string]: unknown;
}

/** Tag each row with the shared marker, preserving every other column. */
function projectLaatu(r: Record<string, unknown>): BetoniLaatuRow {
  return { ...r, shared: Number(r.asiakasId) === SHARED_ASIAKAS_ID } as BetoniLaatuRow;
}

export interface LaatuListOptions {
  asiakas?: number;
  search?: string;
  sharedOnly?: boolean;
  ownOnly?: boolean;
}

/**
 * Resolve the tenant scope, defaulting to the caller's active company.
 *
 * Uses the shared owner resolver (decode-first, server fallback, one exit-4
 * contract) rather than a local decode — six modules had hand-rolled that with
 * three different failure shapes before it was centralized.
 *
 * An explicit id reads ANOTHER supplier's catalogue, which is legitimate and not
 * a privilege escalation: a customer must be able to read the catalogue of the
 * supplier it orders from, which is exactly why the backend route scopes its
 * cache key by supplier instead of restricting to the caller's own tenant.
 */
async function resolveScope(
  client: ApiClient,
  explicit: number | undefined,
  flag: string
): Promise<number> {
  if (explicit !== undefined) return explicit;
  return resolveActiveOwnerAsiakasId(client, `pass ${flag} <asiakasId>`);
}

/**
 * GET /api/betoni/laatu/list/:betoniToimittajaAsiakasId — the grades one
 * supplier can offer: its own rows PLUS the shared ones.
 *
 * The route returns a bare array ordered by sortNum; it is projected into the
 * standard list envelope here. `--shared-only` / `--own-only` split the two
 * populations the single response mixes.
 */
export async function runLaatuList(
  client: ApiClient,
  opts: LaatuListOptions = {}
): Promise<ListEnvelope<BetoniLaatuRow>> {
  if (opts.sharedOnly && opts.ownOnly) {
    failUsage("--shared-only and --own-only are mutually exclusive — they name two disjoint sets");
  }
  const supplier = await resolveScope(client, opts.asiakas, "--asiakas");
  const rows = await client.get<Record<string, unknown>[]>(
    `/api/betoni/laatu/list/${supplier}`
  );
  let items = (rows ?? []).map(projectLaatu);
  if (opts.sharedOnly) items = items.filter((r) => r.shared);
  if (opts.ownOnly) items = items.filter((r) => !r.shared);
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    items = items.filter((r) =>
      [r.laatuNimike, r.laatuLyhenne, r.laatuSelite].some(
        (v) => typeof v === "string" && v.toLowerCase().includes(needle)
      )
    );
  }
  return listEnvelope(items);
}

/**
 * One grade by id.
 *
 * Filters the supplier's list CLIENT-side rather than calling a get endpoint,
 * because there is no route for one: `betoniLaatu.get` exists in the controller
 * but no route mounts it. Doing it this way also keeps the visibility rule
 * identical to `list` — you can only get a grade you could already list.
 */
export async function runLaatuGet(
  client: ApiClient,
  laatuId: number,
  opts: { asiakas?: number } = {}
): Promise<BetoniLaatuRow> {
  const { items } = await runLaatuList(client, { asiakas: opts.asiakas });
  const hit = items.find((r) => Number(r.laatuId) === Number(laatuId));
  if (!hit) {
    throw new CliError(
      `Grade not found in this supplier's catalogue: ${laatuId}`,
      0, null, 5,
      "list the catalogue with `ib betoni laatu list`; a grade owned by ANOTHER supplier is not visible here — pass --asiakas <supplierId>"
    );
  }
  return hit;
}

/** One row of dbo.betoniAttr, plus the derived `shared` marker. */
export interface BetoniAttrRow {
  attrId: number;
  attrNimike: string | null;
  attrSelite: string | null;
  attrYksikkö: string | null;
  hinta: number | null;
  betoniAsiakasId: number;
  ownerAsiakasId: number;
  /** True when the row is global on BOTH scopes (visible to everyone). */
  shared: boolean;
  isEnabled: boolean | null;
  showInDropDown: boolean | null;
  [k: string]: unknown;
}

function projectAttr(r: Record<string, unknown>): BetoniAttrRow {
  return {
    ...r,
    // Both columns use 0 as the "any" sentinel, and the backend matches
    // `IN (@id, 0)` on each independently — so a row is truly shared only when
    // BOTH are 0. A row global on one axis is still scoped on the other.
    shared:
      Number(r.betoniAsiakasId) === SHARED_ASIAKAS_ID &&
      Number(r.ownerAsiakasId) === SHARED_ASIAKAS_ID,
  } as BetoniAttrRow;
}

/**
 * GET /api/betoni/attr/list/:betoniAsiakasId/:ownerAsiakasId — additives
 * available for one supplier under one owning tenant.
 *
 * `--owner` defaults to the caller's active company (which is what the row's
 * ownerAsiakasId is written from on create), so the common call needs only the
 * supplier id.
 */
export async function runAttrList(
  client: ApiClient,
  betoniAsiakasId: number,
  opts: { owner?: number } = {}
): Promise<ListEnvelope<BetoniAttrRow>> {
  const owner = await resolveScope(client, opts.owner, "--owner");
  const rows = await client.get<Record<string, unknown>[]>(
    `/api/betoni/attr/list/${betoniAsiakasId}/${owner}`
  );
  return listEnvelope((rows ?? []).map(projectAttr));
}

/**
 * GET /api/betoni/attr/get/:attrId/:ownerAsiakasId — one additive.
 *
 * The route returns a RECORDSET (an array) even for a single row, so this
 * unwraps it; an empty array means the attribute does not exist OR belongs to
 * another tenant, which the backend deliberately does not distinguish.
 */
export async function runAttrGet(
  client: ApiClient,
  attrId: number,
  opts: { owner?: number } = {}
): Promise<BetoniAttrRow> {
  const owner = await resolveScope(client, opts.owner, "--owner");
  const rows = await client.get<Record<string, unknown>[]>(
    `/api/betoni/attr/get/${attrId}/${owner}`
  );
  const hit = (rows ?? [])[0];
  if (!hit) {
    throw new CliError(
      `Attribute not found: ${attrId}`,
      0, null, 5,
      "the id may belong to another tenant — the backend does not distinguish that from 'no such row'. Check with `ib betoni attr list <betoniAsiakasId> --owner <id>`"
    );
  }
  return projectAttr(hit);
}

/** The four fixed lookup lists, and the routes that serve them. */
const REFERENCE_LISTS = [
  ["raekoko", "/api/betoni/raekoko/list"],
  ["lujuus", "/api/betoni/lujuus/list"],
  ["notkeus", "/api/betoni/notkeus/list"],
  ["kayttoika", "/api/betoni/kayttoika/list"],
] as const;


/**
 * All four concrete reference lists in ONE call.
 *
 * Bundled rather than split into four leaves because they are read together:
 * they are the fixed vocabularies a grade's allowed-values fields
 * (laatuAllowedRae / laatuAllowedS / laatuAllowedC) are expressed in, so a
 * caller decoding a grade needs all of them at once. `--kind` narrows to one.
 * These four routes are unauthenticated reference data and are cached with a
 * 2-hour TTL server-side.
 */
export async function runReference(
  client: ApiClient,
  opts: { kind?: string } = {}
): Promise<Record<string, unknown[]>> {
  const wanted = opts.kind
    ? REFERENCE_LISTS.filter(([k]) => k === opts.kind)
    : REFERENCE_LISTS;
  if (opts.kind && wanted.length === 0) {
    failUsage(
      `--kind must be one of: ${REFERENCE_LISTS.map(([k]) => k).join(", ")}`
    );
  }
  const results = await Promise.all(
    wanted.map(([, path]) => client.get<unknown[]>(path))
  );
  return Object.fromEntries(
    wanted.map(([kind], i) => [kind, results[i] ?? []])
  );
}

/** Register `ib betoni` — read-only concrete reference data (fb#426). */
export function registerBetoniCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const betoni = parent.command("betoni").description("Concrete reference data: grades, additives, lookup lists");

  const laatu = betoni.command("laatu").description("Concrete grades (betoniLaatu)");

  laatu
    .command("list")
    .option("--asiakas <id>", "", intFlag("--asiakas"))
    .option("--search <s>")
    .option("--shared-only")
    .option("--own-only")
    .action(jsonAction(getClient, (client, opts: LaatuListOptions) => runLaatuList(client, opts)));

  laatu
    .command("get <laatuId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .option("--asiakas <id>", "", intFlag("--asiakas"))
    .action(
      jsonAction(getClient, (client, laatuId: string, opts: { asiakas?: number }) =>
        runLaatuGet(client, Number(laatuId), opts)
      )
    );

  const attr = betoni.command("attr").description("Concrete additives (betoniAttr)");

  attr
    .command("list <betoniAsiakasId>")
    .option("--owner <id>", "", intFlag("--owner"))
    .action(
      jsonAction(getClient, (client, betoniAsiakasId: string, opts: { owner?: number }) =>
        runAttrList(client, Number(betoniAsiakasId), opts)
      )
    );

  attr
    .command("get <attrId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .option("--owner <id>", "", intFlag("--owner"))
    .action(
      jsonAction(getClient, (client, attrId: string, opts: { owner?: number }) =>
        runAttrGet(client, Number(attrId), opts)
      )
    );

  betoni
    .command("reference")
    .option("--kind <k>")
    .action(jsonAction(getClient, (client, opts: { kind?: string }) => runReference(client, opts)));
}
