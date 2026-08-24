import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { unwrapRows, listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson, failWith, failUsage, errorMessage } from "../../output/json.js";
import {
  decodeJwtPayload,
  impersonationFromClaims,
  tokenCompanyClaims,
  type ImpersonationInfo,
  type TokenCompanyClaim,
} from "../../auth/jwt.js";
import { resolveCallerTier, type CallerTier } from "../../tier.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import {
  runCombinatorDuplicates,
  runCombinatorMerge,
  registerCombinatorCommands,
  type CombinatorMergeOptions,
} from "../_shared/combinator.js";
import { roleNameForTypeId, resolveRoleTypeId, explainRole } from "../../roles.js";
import {
  projectHistoryRow,
  type ChangeHistoryItem,
  type RawChangeRow,
} from "../log/changeRow.js";
import {
  parseId,
  parseOptionalId,
  resolveSearchQuery,
  cappedInt,
  addOwnerOption,
  queryAliasOption,
} from "../../targets.js";
import { runCompanyList } from "../company/index.js";
import { runNotificationFcmSend } from "../notification/index.js";
import { CliError } from "../../api/errors.js";
import { parseJsonBodyFlag, resolveJsonObjectBody } from "../../api/parseBody.js";
import { registerPersonDayCommands } from "./day.js";
import { registerPersonEmailCommands } from "./email.js";
import { registerPersonAbsencesCommand } from "./absences.js";
import { registerPersonActivityCommand } from "./activity.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";
import { bothInOrder } from "../../parallel.js";

export interface PersonListFilter {
  role?: string;
  asiakas?: number;
  /** List persons the company OWNS instead of its members (the default). */
  owned?: boolean;
  limit?: number;
}

/** Typed convenience fields for `person create`, mapped to backend column names. */
export interface PersonCreateFlags {
  first?: string;
  last?: string;
  phone?: string;
  /** Optional — the DB and backend accept a person with no email (phone-only contacts). */
  email?: string;
  /** Optional free-text note/comment (personMemo column). */
  memo?: string;
  asiakas?: number;
  /** Create a global, self-managing person (ownerAsiakasId=null). Mutually exclusive with asiakas. */
  global?: boolean;
}

/**
 * Merge typed create flags over a parsed --body object (typed flags win) into the
 * /api/person/newPerson body. Email is intentionally optional: person.personEmail
 * is nullable and the backend only dedupes when an email is actually given, so a
 * phone-first contact can be created now and have its email added later. Body keys
 * not covered by a typed flag are preserved untouched.
 */
export function buildPersonCreateBody(
  parsedBody: Record<string, unknown>,
  typed: PersonCreateFlags
): Record<string, unknown> {
  const body = { ...parsedBody };
  if (typed.first !== undefined) body.personFirstName = typed.first;
  if (typed.last !== undefined) body.personLastName = typed.last;
  if (typed.phone !== undefined) body.personPhone = typed.phone;
  if (typed.email !== undefined) body.personEmail = typed.email;
  if (typed.memo !== undefined) body.personMemo = typed.memo;
  if (typed.asiakas !== undefined) body.ownerAsiakasId = typed.asiakas;
  if (typed.global) body.ownerAsiakasId = null;
  return body;
}

/** Typed convenience fields for `person update`, mapped to backend column names. */
export interface PersonUpdateFlags {
  first?: string;
  last?: string;
  phone?: string;
  email?: string;
  memo?: string;
}

/**
 * Merge typed update flags over a parsed --body patch (typed flags win) into the
 * /api/person/set patch body. Only fields whose flag was actually provided are
 * included, so any column the caller omitted is left out of the patch — the
 * backend `personSql.setData` read-merges omitted columns back to the stored row
 * (an explicit "" still clears). Body keys not covered by a typed flag are
 * preserved untouched. Mirrors buildPersonCreateBody so `create`/`update` share
 * one flag vocabulary. Owner changes are intentionally NOT here — use
 * `ib person owner` (separate authz).
 */
export function buildPersonUpdateBody(
  parsedBody: Record<string, unknown>,
  typed: PersonUpdateFlags
): Record<string, unknown> {
  const body = { ...parsedBody };
  if (typed.first !== undefined) body.personFirstName = typed.first;
  if (typed.last !== undefined) body.personLastName = typed.last;
  if (typed.phone !== undefined) body.personPhone = typed.phone;
  if (typed.email !== undefined) body.personEmail = typed.email;
  if (typed.memo !== undefined) body.personMemo = typed.memo;
  return body;
}

/**
 * Required-field check for person create: first + last name (email is optional).
 * Treats null/empty as missing. Returns the missing flag labels (empty = ok).
 */
export function missingPersonCreateFields(body: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
  if (!present(body.personFirstName)) missing.push("--first (personFirstName)");
  if (!present(body.personLastName)) missing.push("--last (personLastName)");
  return missing;
}

/**
 * GET /api/cli/person/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runPersonList(
  client: ApiClient,
  opts: PersonListFilter
): Promise<ListEnvelope<Record<string, unknown>>> {
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/person/list${qs({
      role: opts.role || undefined,
      asiakas: opts.asiakas,
      limit: opts.limit,
      owned: opts.owned ? "1" : undefined,
    })}`
  );
}

/**
 * GET /api/cli/person/get/:personId. Returns the flat backend record as-is.
 *
 * `asiakas` widens the read to ANOTHER tenant (fb#620), mirroring
 * `ib vehicle get --asiakas` — same shape, same gate class (membership of the
 * target, or sysadmin/developer). Without it the lookup is scoped to the active
 * company, which is what made a correct personId answer "not found": a developer
 * token that could read another tenant's FLEET could not read a person in that
 * same tenant, and the 404 blamed the id.
 *
 * DEPLOY-GATED: the `?asiakas=` half needs the puminet5api route change. Against
 * an older backend the parameter is ignored and the read stays scoped to the
 * active company — i.e. the pre-fix 404, never a wrong person.
 */
export async function runPersonGet(
  client: ApiClient,
  personId: number,
  asiakas?: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/person/get/${personId}${qs({ asiakas })}`
  );
}

/** A projected person search hit (the documented ListEnvelope row). */
export interface PersonSearchHit {
  personId: number;
  name: string;
  email: string | null;
  phone: string | null;
  asiakasId: number | null;
}

/** Project one raw /api/person/search row to the clean PersonSearchHit shape. */
export function projectPersonHit(row: Record<string, unknown>): PersonSearchHit {
  const first = (row.personFirstName as string) ?? "";
  const last = (row.personLastName as string) ?? "";
  return {
    personId: Number(row.personId),
    name: `${first} ${last}`.trim(),
    email: (row.personEmail as string) ?? null,
    phone: (row.personPhone as string) ?? null,
    asiakasId: row.ownerAsiakasId != null ? Number(row.ownerAsiakasId) : null,
  };
}

/**
 * POST /api/person/search — existing (non-/api/cli/) route used by the FE
 * person typeahead. Body is `{ searchString: <query> }`. The backend scopes
 * results to the caller's company (req.user.ownerAsiakasId) when no
 * ownerAsiakasId is in the body, so the CLI omits it by default. Sent with
 * `{ read: true }` so this read-over-POST is exempt from the `--read-only`
 * write-lock and the acting-as diagnostic. The raw backend rows (a bare array
 * or an mssql `{ recordset }` wrapper) are normalised via `unwrapRows` and
 * projected by `projectPersonHit` into the documented
 * `ListEnvelope<PersonSearchHit>`.
 *
 * `ownerAsiakasId` (from `--asiakas <id>`) searches ANOTHER tenant instead of
 * the active company. The backend gates it with `canAccessOwnerAsiakas`, which
 * allows a company you belong to — or ANY company for a sysadmin/developer, the
 * cross-tenant lever this flag exists for (feedback #310). Unauthorized → 403.
 */
export async function runPersonSearch(
  client: ApiClient,
  query: string,
  limit?: number,
  ownerAsiakasId?: number
): Promise<ListEnvelope<PersonSearchHit>> {
  const body: Record<string, unknown> = { searchString: query };
  if (limit !== undefined) body.limit = limit;
  if (ownerAsiakasId !== undefined) body.ownerAsiakasId = ownerAsiakasId;
  const raw = await client.post<unknown>("/api/person/search", body, { read: true });
  const items = unwrapRows(raw).map(projectPersonHit);
  return listEnvelope(items);
}

/** A cross-company search hit: a PersonSearchHit plus its authoritative company. */
export interface MyCompanyPersonHit extends PersonSearchHit {
  asiakasName: string;
}

/**
 * Search persons across the caller's companies (`--my-companies`) via the
 * server-side endpoint `GET /api/cli/person/search` — ONE round-trip, no
 * per-company switching. If that endpoint isn't deployed yet (404/405), falls
 * back to the legacy client-side fan-out so the command works pre- and
 * post-deploy. `opts.fallback` supplies the fan-out; `opts.limit` is forwarded.
 */
export function runPersonSearchMyCompanies(
  client: ApiClient,
  query: string,
  opts: {
    limit?: number;
    fallback: () => Promise<ListEnvelope<MyCompanyPersonHit>>;
  }
): Promise<ListEnvelope<MyCompanyPersonHit>> {
  return orLegacy(
    () =>
      client.get<ListEnvelope<MyCompanyPersonHit>>(
        `/api/cli/person/search${qs({ q: query, limit: opts.limit })}`
      ),
    opts.fallback
  );
}

/**
 * Deploy gate: run `primary`; on 404/405 — the route does not exist on THIS
 * backend yet — run `fallback` instead. Any other failure propagates.
 *
 * Only safe where a deployed route cannot answer 404 for a legitimately missing
 * resource; both current callers return an empty list rather than 404 for
 * "nothing found", so a 404 here can only mean "not deployed". File-local on
 * purpose — these are the only two deploy gates in the CLI (every other
 * `statusCode === 404` check in src/ is a resource-404 handler).
 */
async function orLegacy<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (e instanceof CliError && (e.statusCode === 404 || e.statusCode === 405)) {
      return fallback();
    }
    throw e;
  }
}

/**
 * Search EVERY tenant (`--all-companies`) via `GET /api/cli/person/search/global`
 * — the true global sweep, developer/sysadmin-gated server-side (403 otherwise).
 *
 * Deliberately has NO client-side fallback, unlike `--my-companies`: a global
 * sweep cannot be synthesized from the caller's own memberships, so a 404 (route
 * not deployed) must surface rather than silently degrade into a narrower
 * result the caller would read as "these are all the matches" (feedback #310).
 * `hintForError` already turns the backend's `code: ROUTE_NOT_FOUND` into the
 * not-deployed remedy.
 */
export async function runPersonSearchAllCompanies(
  client: ApiClient,
  query: string,
  limit?: number
): Promise<ListEnvelope<MyCompanyPersonHit>> {
  return client.get<ListEnvelope<MyCompanyPersonHit>>(
    `/api/cli/person/search/global${qs({ q: query, limit })}`
  );
}

/**
 * Legacy client-side fan-out for `--my-companies` (the fallback when the
 * server endpoint isn't deployed). `listCompanies` yields the companies to
 * sweep; `searchIn(asiakasId)` runs the search in one company (the caller binds
 * the query + an ephemeral per-company client). Each hit is tagged with its
 * authoritative company and merged into one ListEnvelope.
 */
export async function runPersonSearchMyCompaniesFanout(
  listCompanies: () => Promise<{ asiakasId: number; name: string }[]>,
  searchIn: (asiakasId: number) => Promise<ListEnvelope<PersonSearchHit>>
): Promise<ListEnvelope<MyCompanyPersonHit>> {
  const companies = await listCompanies();
  // Each per-company search is independent (its own ephemeral client), so run
  // them concurrently with a small cap — a many-company account should not
  // open a socket per company. Hits keep the companies' input order.
  const CONCURRENCY = 5;
  const perCompany = new Array<ListEnvelope<PersonSearchHit>>(companies.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, companies.length) }, async () => {
      while (next < companies.length) {
        const i = next++;
        perCompany[i] = await searchIn(companies[i].asiakasId);
      }
    })
  );
  const items: MyCompanyPersonHit[] = companies.flatMap((c, i) =>
    perCompany[i].items.map((hit) => ({ ...hit, asiakasId: c.asiakasId, asiakasName: c.name }))
  );
  return listEnvelope(items);
}

/** One person↔company role row, with the role name resolved. */
export interface PersonRoleListItem {
  asiakasPersonSettingId: number;
  roleTypeId: number;
  role: string | null;
}

interface AsiakasPersonSettingRow {
  asiakasPersonSettingId: number;
  asiakasPersonSettingTypeId: number;
}

/**
 * GET /api/asiakasPersonSettings/get/:asiakasId/:personId — the per-company
 * roles a person holds. Resolves each asiakasPersonSettingTypeId to its role
 * name (null for non-role/unknown typeIds). The backend may return a bare
 * array or an mssql wrapper ({ recordset } / { recordsets }) depending on cache
 * warmth — unwrap defensively. Wrapped in the universal ListEnvelope.
 */
export async function runPersonRoleList(
  client: ApiClient,
  personId: number,
  asiakasId: number
): Promise<ListEnvelope<PersonRoleListItem>> {
  const raw = await client.get<
    AsiakasPersonSettingRow[] | { recordset?: AsiakasPersonSettingRow[]; recordsets?: AsiakasPersonSettingRow[][] }
  >(`/api/asiakasPersonSettings/get/${asiakasId}/${personId}`);
  let rows: AsiakasPersonSettingRow[] = [];
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && typeof raw === "object") {
    rows = raw.recordset || raw.recordsets?.[0] || [];
  }
  const items = rows.map((r) => ({
    asiakasPersonSettingId: r.asiakasPersonSettingId,
    roleTypeId: r.asiakasPersonSettingTypeId,
    role: roleNameForTypeId(r.asiakasPersonSettingTypeId),
  }));
  return listEnvelope(items);
}

/**
 * POST /api/asiakasPersonSettings/add/:asiakasId/:personId/:roleTypeId — grant
 * a per-company role. roleTypeId fills the route's positional :personSettingTypeId
 * segment. Body is empty ({}). Write-flag headers (incl. X-Dry-Run) are forwarded;
 * under dry-run the wrapped backend returns { dryRun:true, wouldCreate }.
 */
export async function runPersonRoleGrant(
  client: ApiClient,
  personId: number,
  asiakasId: number,
  roleTypeId: number,
  flags: WriteFlags
): Promise<unknown> {
  const result = await client.post<unknown>(
    `/api/asiakasPersonSettings/add/${asiakasId}/${personId}/${roleTypeId}`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
  // A real write returns bare/raw backend success (useless to an agent); project
  // it to `{ granted: { personId, asiakasId, roleTypeId } }` (the ids are the
  // inputs). A dry-run preview (`{ dryRun, wouldCreate }`) is passed through.
  if (result && typeof result === "object" && (result as { dryRun?: unknown }).dryRun) {
    return result;
  }
  return { granted: { personId, asiakasId, roleTypeId } };
}

/**
 * Revoke a per-company role. Two-step: list the person's roles for the company,
 * find the row whose roleTypeId matches, then DELETE it by asiakasPersonSettingId.
 * Idempotent — returns { removed: 0 } (no DELETE) when the role is absent. Under
 * --dry-run the DELETE forwards X-Dry-Run and the wrapped backend returns
 * { dryRun:true, wouldDelete }, passed through; otherwise returns { removed: 1 }.
 */
export async function runPersonRoleRevoke(
  client: ApiClient,
  personId: number,
  asiakasId: number,
  roleTypeId: number,
  flags: WriteFlags
): Promise<unknown> {
  const current = await runPersonRoleList(client, personId, asiakasId);
  const match = current.items.find((i) => i.roleTypeId === roleTypeId);
  if (!match) return { removed: 0 };
  const res = await client.delete(
    `/api/asiakasPersonSettings/delete/${match.asiakasPersonSettingId}`,
    { headers: writeFlagsToHeaders(flags) }
  );
  return flags.dryRun ? res : { removed: 1 };
}

/** Caller's own profile + roles (aggregated across all their companies) + actable companies. */
export interface PersonMeOutput {
  personId: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  activeCompany: { asiakasId: number; name: string | null };
  /**
   * The caller's capability/discovery tier (developer > admin > standard) —
   * which command subtrees even exist for it. The MCP-reachable equivalent of
   * `auth whoami`'s `tier` (the `auth` group is denied over /api/cli/exec).
   */
  tier: CallerTier;
  roles: { roleTypeId: number; role: string | null }[];
  companies: { asiakasId: number; name: string; current: boolean }[];
  /** Present only when the active token is an impersonation JWT (acting as another person). */
  impersonating?: ImpersonationInfo;
}

/**
 * `ib person me` — the caller's own rich profile. Derives personId from the JWT
 * (works for IB_TOKEN sessions with no credentials file), then composes
 * /api/cli/person/get/:personId (profile + roles) and
 * /api/company-selection/available (actable companies). `roles` are aggregated
 * across ALL the person's companies (the backend role subquery is not asiakas-
 * scoped); use `person role list --asiakas <id>` for one company's roles.
 */
export async function runPersonMe(client: ApiClient): Promise<PersonMeOutput> {
  const token = client.getCurrentToken();
  const claims = decodeJwtPayload(token);
  const impersonating = impersonationFromClaims(claims);
  const personId =
    claims.personId ?? failWith("could not resolve personId from the active token", 4);
  const [profile, available] = await bothInOrder(
    client.get<{
      personId: number; name: string | null; email: string | null; phone: string | null; roles: number[];
    }>(`/api/cli/person/get/${personId}`),
    client.get<{
      companies: { asiakasId: number; asiakasNimi?: string; name?: string }[]; currentCompanyId: number;
    }>(`/api/company-selection/available`)
  );
  const companies = available.companies || [];
  const active = companies.find((c) => c.asiakasId === available.currentCompanyId);
  return {
    personId,
    name: profile.name ?? null,
    email: profile.email ?? claims.email ?? null,
    phone: profile.phone ?? null,
    activeCompany: {
      asiakasId: available.currentCompanyId,
      name: active?.asiakasNimi ?? active?.name ?? null,
    },
    tier: resolveCallerTier(token),
    roles: (profile.roles || []).map((t) => ({ roleTypeId: t, role: roleNameForTypeId(t) })),
    companies: companies.map((c) => ({
      asiakasId: c.asiakasId,
      name: c.asiakasNimi ?? c.name ?? "",
      current: c.asiakasId === available.currentCompanyId,
    })),
    ...(impersonating ? { impersonating } : {}),
  };
}

/** One company row from `ib person companies` — see {@link runPersonCompanies}. */
export interface PersonCompanyItem {
  asiakasId: number;
  name: string | null;
  /**
   * Role names held in this company (from the same source that mints the JWT
   * claim). `null` = the source could not report them, which happens ONLY on the
   * pre-deploy fallback — it does NOT mean "no roles": every row the fallback
   * returns provably holds at least one enabled, in-validity role.
   */
  roles: string[] | null;
  /** null on the pre-deploy fallback — unknown, not false. See {@link PersonCompanyItem.roles}. */
  isTyomaaAsiakas: boolean | null;
  isPumppuToimittaja: boolean | null;
  isBetoniToimittaja: boolean | null;
  isLattiaToimittaja: boolean | null;
  /**
   * `true` when the person also has an ENABLED, in-validity role attachment here
   * (`person_getUserAsiakasList`). `false` means "authorized, but holds no live
   * role" — an authorized company either way.
   */
  activeMembership: boolean;
}

export interface PersonCompaniesOutput extends ListEnvelope<PersonCompanyItem> {
  personId: number;
  /**
   * Which membership notion produced these rows.
   * `asiakas_listForPerson` = the authorization set (matches the JWT claim).
   * `person_getUserAsiakasList` = the pre-deploy fallback: the NARROWER active-
   * membership set, with no roles/flags — a strict subset of the authorization set.
   */
  source: "asiakas_listForPerson" | "person_getUserAsiakasList";
  /** Present only on the fallback, naming what the answer is missing. */
  hint?: string;
}

const LEGACY_SOURCE_HINT =
  "backend route /api/cli/person/:personId/companies is not deployed yet — these rows are the NARROWER active-membership set and may omit companies the backend still authorizes. roles/is* are null (this source cannot report them), NOT empty. Use `ib person companies --as-token` for the authorization claim.";

/**
 * `ib person companies [personId]` — the companies a person belongs to, in the
 * notion backend authorization actually uses. personId defaults to the caller.
 *
 * Reads GET /api/cli/person/:personId/companies, which is built from the exact
 * pipeline that mints the JWT `asiakasesWithTypes` claim, so it cannot disagree
 * with what gates the API. Each row carries `activeMembership` for the narrower
 * "has a live role here" notion, so both readings are available and neither
 * silently stands in for the other (feedback #395).
 *
 * Falls back to the legacy GET /api/person/getUserAsiakasList/:personId on
 * 404/405 (same deploy-gate pattern as `person search --my-companies`), tagging
 * `source` + `hint` so a pre-deploy answer is self-describing rather than
 * quietly narrower.
 */
export async function runPersonCompanies(
  client: ApiClient,
  personId?: number
): Promise<PersonCompaniesOutput> {
  const id =
    personId ??
    decodeJwtPayload(client.getCurrentToken()).personId ??
    failWith("could not resolve personId from the active token", 4);
  return orLegacy(
    () => client.get<PersonCompaniesOutput>(`/api/cli/person/${id}/companies`),
    () => runPersonCompaniesLegacy(client, id)
  );
}

/**
 * Pre-deploy fallback: GET /api/person/getUserAsiakasList/:personId (the NARROW
 * proc). Roles and the toimittaja flags come back `null` — NOT empty/false: that
 * proc requires an enabled, in-validity role attachment, so every row provably
 * holds a role, and reporting `[]` would be an affirmative wrong answer of
 * exactly the kind fb#395 exists to eliminate. `activeMembership` is `true` by
 * construction. The JSON key set is unchanged, so consumers need no shape branch.
 */
async function runPersonCompaniesLegacy(
  client: ApiClient,
  personId: number
): Promise<PersonCompaniesOutput> {
  const raw = await client.get<unknown>(`/api/person/getUserAsiakasList/${personId}`);
  const items: PersonCompanyItem[] = unwrapRows(raw).map((r) => ({
    asiakasId: Number(r.asiakasId),
    name: (r.asiakasNimi ?? r.asiakasName ?? r.name ?? null) as string | null,
    roles: null,
    isTyomaaAsiakas: null,
    isPumppuToimittaja: null,
    isBetoniToimittaja: null,
    isLattiaToimittaja: null,
    activeMembership: true,
  }));
  return {
    ...listEnvelope(items),
    personId,
    source: "person_getUserAsiakasList",
    hint: LEGACY_SOURCE_HINT,
  };
}

export interface PersonCompaniesTokenOutput extends ListEnvelope<TokenCompanyClaim> {
  personId: number;
  source: "jwt-claim";
  /**
   * When the token was minted — the claim is a snapshot as of this instant.
   * `null` on compact/short-shape tokens, which are signed without `iat`; treat
   * null as "unknown", not "just now".
   */
  mintedAt: string | null;
  hint: string;
}

/**
 * `ib person companies --as-token` — the `asiakasesWithTypes` claim of the ACTIVE
 * token, verbatim. This is literally what backend authorization reads, so it is
 * the ground truth for "why did that endpoint let me in / 403 me".
 *
 * Offline (no request) and self-only: a token carries only its own bearer's
 * memberships, so there is no honest way to answer it for another personId.
 */
export function runPersonCompaniesAsToken(
  client: ApiClient,
  personId?: number
): PersonCompaniesTokenOutput {
  const token = client.getCurrentToken();
  const self =
    decodeJwtPayload(token).personId ??
    failWith("could not resolve personId from the active token", 4);
  if (personId !== undefined && personId !== self) {
    failUsage(
      `--as-token reports the ACTIVE token's own claim, so it only works for personId ${self} (the caller); got ${personId}. Drop --as-token to read personId ${personId}'s companies from the backend.`
    );
  }
  const { mintedAt, companies } = tokenCompanyClaims(token);
  return {
    ...listEnvelope(companies),
    personId: self,
    source: "jwt-claim",
    mintedAt,
    hint: "a SNAPSHOT taken when the token was minted (mintedAt; null on compact/short-shape tokens, which are signed without iat) — a company added or role granted since is absent until the token is re-minted (ib company switch / re-login).",
  };
}

/**
/** person-combinator request-body id fields (see puminet5api personCombinatorRoutes). */
const PERSON_MERGE_ID_FIELDS = {
  mainField: "mainPersonId",
  secondaryField: "secondaryPersonId",
} as const;

/**
 * GET /api/admin/person-combinator/duplicates — likely-duplicate person pairs
 * for one tenant (same phone / email / first+last name). Admin gated server-side.
 * Feeds `ib person merge`. See runCombinatorDuplicates for the envelope shape.
 */
export function runPersonDuplicates(client: ApiClient, ownerAsiakasId: number) {
  return runCombinatorDuplicates(client, "person-combinator", ownerAsiakasId);
}

/**
 * Merge two duplicate persons — the secondary's references move onto the main,
 * then the secondary is deleted. IRREVERSIBLE, admin gated. `--dry-run` runs the
 * read-only /validate safety check (works under --read-only). See runCombinatorMerge.
 */
export function runPersonMerge(
  client: ApiClient,
  opts: CombinatorMergeOptions,
  flags: WriteFlags
) {
  return runCombinatorMerge(client, "person-combinator", PERSON_MERGE_ID_FIELDS, opts, flags);
}

/**
 * Register `ib person` read subcommands on the parent commander instance:
 *   - list    filterable by --role/--asiakas/--limit
 *   - get     single person by personId
 *   - search  free-text search (existing POST /api/person/search route)
 *   - duplicates  likely-duplicate person pairs for a tenant (read; admin; feeds merge)
 *   - merge   merge two duplicate persons (--dry-run = /validate; IRREVERSIBLE; requires --reason)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerPersonCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  getClientForAsiakas: (asiakasId: number) => Promise<ApiClient>
): void {
  const p = parent.command("person").description("Person commands");
  registerPersonDayCommands(p, getClient);
  registerPersonEmailCommands(p, getClient);
  registerPersonAbsencesCommand(p, getClient);
  registerPersonActivityCommand(p, getClient);

  p.command("list")
    .option("--role <role>")
    .option("--asiakas <id>", "", (v: string) => Number(v))
    .option(
      "--owned"
    )
    .option("--limit <n>", "", cappedInt(500))
    .action(jsonAction(getClient, (client, opts: PersonListFilter) => runPersonList(client, opts)));

  p.command("get <personId>")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .option("--asiakas <id>", "", (v: string) => Number(v))
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { asiakas?: number }) =>
        runPersonGet(client, parseId(idStr, "personId"), opts.asiakas)
      )
    );

  p.command("search [query]")
    .option("--search <s>")
    .addOption(queryAliasOption())
    .option("--limit <n>", "", cappedInt(500))
    .option(
      "--my-companies"
    )
    .option(
      "--asiakas <id>",
      "",
      (v: string) => Number(v)
    )
    .option(
      "--all-companies"
    )
    .action(
      guarded(async (
        query: string | undefined,
        opts: {
          search?: string;
          query?: string;
          limit?: number;
          myCompanies?: boolean;
          asiakas?: number;
          allCompanies?: boolean;
        }
      ) => {
        // The three scope flags name three DIFFERENT result sets; silently
        // letting one win would answer a question the caller did not ask.
        const scopes = [
          opts.myCompanies && "--my-companies",
          opts.allCompanies && "--all-companies",
          opts.asiakas !== undefined && "--asiakas",
        ].filter(Boolean) as string[];
        if (scopes.length > 1) {
          failUsage(
            `${scopes.join(" and ")} are mutually exclusive — pick one scope ` +
              `(--asiakas <id> = one other company, --my-companies = the companies you belong to, ` +
              `--all-companies = every tenant)`
          );
        }
        const client = await getClient();
        const q = resolveSearchQuery(query, opts.search, opts.query);
        if (opts.allCompanies) {
          writeJson(await runPersonSearchAllCompanies(client, q, opts.limit));
          return;
        }
        if (opts.asiakas !== undefined) {
          writeJson(
            await runPersonSearch(client, q, opts.limit, parseId(String(opts.asiakas), "asiakasId"))
          );
          return;
        }
        if (opts.myCompanies) {
          const result = await runPersonSearchMyCompanies(client, q, {
            limit: opts.limit,
            // Fallback used only if the server endpoint isn't deployed yet.
            fallback: () =>
              runPersonSearchMyCompaniesFanout(
                async () =>
                  (await runCompanyList(client)).items.map((c) => ({
                    asiakasId: c.asiakasId,
                    name: c.name,
                  })),
                async (asiakasId) =>
                  runPersonSearch(
                    await getClientForAsiakas(asiakasId),
                    q,
                    opts.limit
                  )
              ),
          });
          writeJson(result);
          return;
        }
        const result = await runPersonSearch(client, q, opts.limit);
        writeJson(result);
      })
    );

  const notifyCmd = p
    .command("notify <person>")
    .requiredOption("--title <text>")
    .requiredOption("--body <text>")
    .option(
      "--data <json>",
      "",
      (raw: string) => parseJsonBodyFlag(raw, "--data")
    );
  addWriteFlagsToCommand(notifyCmd).action(
    guarded(async (
      person: string,
      opts: WriteFlags & {
        title: string;
        body: string;
        data?: Record<string, unknown>;
      }
    ) => {
      const result = await runNotificationFcmSend(
        await getClient(),
        { person, title: opts.title, body: opts.body, data: opts.data },
        opts
      );
      writeJson(result);
    })
  );

  const createCmd = p
    .command("create")
    .option("--first <s>")
    .option("--last <s>")
    .option("--phone <s>")
    .option("--email <s>")
    .option("--memo <s>")
    .option("--asiakas <id>", "", Number)
    .option(
      "--global"
    )
    .option(
      "--get-or-create"
    )
    .option("--body <json>")
    .option(
      "--from-json <file>"
    );
  addWriteFlagsToCommand(createCmd).action(
    guarded(async (
      opts: WriteFlags & PersonCreateFlags & { getOrCreate?: boolean; body?: string; fromJson?: string }
    ) => {
      // --global and --asiakas are mutually exclusive owner directives.
      if (opts.global && opts.asiakas !== undefined) {
        failWith("--global and --asiakas are mutually exclusive", 4);
      }
      const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
      const body = buildPersonCreateBody(parsed, {
        first: opts.first,
        last: opts.last,
        phone: opts.phone,
        email: opts.email,
        memo: opts.memo,
        asiakas: opts.asiakas,
        global: opts.global,
      });
      const missing = missingPersonCreateFields(body);
      if (missing.length > 0) {
        failWith(`create requires: ${missing.join(", ")}`, 4);
      }
      const client = await getClient();
      // ownerAsiakasId is needed by person_add; default it to the active company
      // when neither --asiakas nor --body supplied one — but NOT for --global,
      // whose null owner is intentional.
      if (!opts.global && (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null)) {
        body.ownerAsiakasId = await resolveActiveOwnerAsiakasId(
          client,
          "run `ib auth switch` or pass --asiakas / ownerAsiakasId in --body"
        );
      }
      let res: unknown;
      try {
        res = await runPersonCreate(client, body, opts);
      } catch (e) {
        // --get-or-create: a duplicate email isn't a failure — return the
        // person that already owns it (so bulk onboarding is idempotent).
        if (opts.getOrCreate && body.personEmail && isDuplicateEmailError(e)) {
          let existing: Awaited<ReturnType<typeof runPersonByEmail>> = null;
          try {
            existing = await runPersonByEmail(client, String(body.personEmail));
          } catch (lookupErr) {
            // The recovery lookup itself can 404 (the email's owner is in a
            // company you can't see, or the route isn't deployed). Don't surface
            // that as a misleading "person not found" — fall through to the clear
            // guidance below.
            if (!(lookupErr instanceof CliError && lookupErr.statusCode === 404)) throw lookupErr;
          }
          if (existing) {
            writeJson({ ...existing, reused: true });
            return;
          }
          // The email collides globally (the dedup is not tenant-scoped) but its
          // owner is not visible to you — --get-or-create can only hand back a
          // person you can access. Give an actionable error, not a bare 400/404.
          failWith(
            `email ${body.personEmail} is already in use by a person you cannot access ` +
              `(likely owned by another company). --get-or-create only returns persons ` +
              `visible to you — locate them with \`ib person search --my-companies\` or use a different email.`,
            4
          );
        }
        throw e;
      }
      // Dry-run returns the backend's wouldCreate echo verbatim.
      if (opts.dryRun) {
        writeJson(res);
        return;
      }
      // Return a clean person record (re-fetched) instead of the raw SQL
      // recordset (returnValue:N) the create proc emits.
      const newId = extractPersonId(res);
      if (!newId) {
        writeJson(res);
        return;
      }
      let created: Record<string, unknown>;
      try {
        created = await runPersonGet(client, newId);
      } catch (e) {
        // GET /api/cli/person/get is scoped to your ACTIVE company, so a person
        // created under a non-active owned company (--asiakas <other>) 404s on
        // read-back even though the create COMMITTED. Synthesize the record from
        // the inputs instead of surfacing a misleading "person not found" that
        // implies the write failed.
        if (e instanceof CliError && e.statusCode === 404) {
          created = {
            personId: newId,
            name: `${body.personFirstName || ""} ${body.personLastName || ""}`.trim() || null,
            email: (body.personEmail as string | null | undefined) ?? null,
            phone: (body.personPhone as string | null | undefined) ?? null,
            ownerAsiakasId: body.ownerAsiakasId ?? null,
            note: "created under a non-active company; record synthesized from inputs (the read-back is scoped to your active company)",
          };
        } else {
          throw e;
        }
      }
      writeJson(opts.getOrCreate ? { ...created, reused: false } : created);
    })
  );

  addWriteFlagsToCommand(
    p
      .command("update <personId>")
      .option("--first <s>")
      .option("--last <s>")
      .option("--phone <s>")
      .option("--email <s>")
      .option("--memo <s>")
      .option("--body <json>")
      .option(
        "--from-json <file>"
      )
  ).action(
    guarded(async (
      personIdStr: string,
      opts: WriteFlags & PersonUpdateFlags & { body?: string; fromJson?: string }
    ) => {
      const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
      const patch = buildPersonUpdateBody(parsed, {
        first: opts.first,
        last: opts.last,
        phone: opts.phone,
        email: opts.email,
        memo: opts.memo,
      });
      if (Object.keys(patch).length === 0) {
        failWith(
          "update requires at least one field: typed flags (--first/--last/--phone/--email/--memo) or a --body/--from-json JSON patch",
          4
        );
      }
      const client = await getClient();
      const result = await runPersonUpdate(client, parseId(personIdStr, "personId"), patch, opts);
      writeJson(result);
    })
  );

  addWriteFlagsToCommand(
    p
      .command("owner <personId>")
      .option("--global")
      .option("--asiakas <id>", "", Number)
  ).action(guarded(async (personIdStr: string, opts: WriteFlags & { global?: boolean; asiakas?: number }) => {
    const hasGlobal = !!opts.global;
    const hasAsiakas = opts.asiakas !== undefined;
    if (hasGlobal === hasAsiakas) {
      failWith("provide exactly one of --global or --asiakas <id>", 4);
    }
    const ownerAsiakasId = hasGlobal ? null : (opts.asiakas as number);
    const client = await getClient();
    const result = await runPersonSetOwner(client, parseId(personIdStr, "personId"), ownerAsiakasId, opts);
    writeJson(result);
  }));

  addWriteFlagsToCommand(
    p
      .command("delete <personId>")
  ).action(guarded(async (personIdStr: string, opts: WriteFlags) => {
    const client = await getClient();
    const result = await runPersonDelete(client, parseId(personIdStr, "personId"), opts);
    writeJson(result);
  }));

  // ─── person role subgroup ────────────────────────────────────────────────
  const personRole = p
    .command("role")
    .description("Manage a person's per-company roles (asiakasPersonSettings)");

  personRole
    .command("list <personId>")
    .requiredOption("--asiakas <id>", "", (v: string) => Number(v))
    .action(
      jsonAction(getClient, (client, personIdStr: string, opts: { asiakas: number }) =>
        runPersonRoleList(client, parseId(personIdStr, "personId"), opts.asiakas)
      )
    );

  addWriteFlagsToCommand(
    personRole
      .command("grant <personId>")
      .requiredOption("--role <name>")
      .requiredOption("--asiakas <id>", "", (v: string) => Number(v))
  ).action(guarded(async (personIdStr: string, opts: WriteFlags & { role: string; asiakas: number }) => {
    let roleTypeId: number;
    try {
      roleTypeId = resolveRoleTypeId(opts.role);
    } catch (validationErr) {
      failWith(errorMessage(validationErr), 4);
    }
    // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
    // must name a real role, so reject the empty-string case rather than POST a
    // bogus roleTypeId 0 to the backend.
    if (!roleTypeId) {
      failWith("--role must not be empty", 4);
    }
    const client = await getClient();
    const result = await runPersonRoleGrant(client, parseId(personIdStr, "personId"), opts.asiakas, roleTypeId, opts);
    writeJson(result);
  }));

  addWriteFlagsToCommand(
    personRole
      .command("revoke <personId>")
      .requiredOption("--role <name>")
      .requiredOption("--asiakas <id>", "", (v: string) => Number(v))
  ).action(guarded(async (personIdStr: string, opts: WriteFlags & { role: string; asiakas: number }) => {
    let roleTypeId: number;
    try {
      roleTypeId = resolveRoleTypeId(opts.role);
    } catch (validationErr) {
      failWith(errorMessage(validationErr), 4);
    }
    // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
    // must name a real role, so reject the empty-string case rather than POST a
    // bogus roleTypeId 0 to the backend.
    if (!roleTypeId) {
      failWith("--role must not be empty", 4);
    }
    const client = await getClient();
    const result = await runPersonRoleRevoke(client, parseId(personIdStr, "personId"), opts.asiakas, roleTypeId, opts);
    writeJson(result);
  }));

  // `explain` resolves typeId/tiers/deprecation OFFLINE from @ibetoni/constants,
  // then enriches with the LIVE DB description/comment via an authenticated GET
  // (GET /api/asiakasPersonSettings/getAllTypes) — the network/transform logic
  // lives in `explainRole` (src/roles.ts), keeping this action thin. It disambiguates
  // the role names accepted by `person role grant/revoke` (and `customer person list --role`).
  personRole
    .command("explain <name>")
    .action(jsonAction(getClient, (client, name: string) => explainRole(client, name)));

  // ─── self-introspection ───────────────────────────────────────────────────
  p.command("me")
    .action(jsonAction(getClient, runPersonMe));

  p.command("companies [personId]")
    .option("--as-token")
    .action(
      jsonAction(getClient, (client, personIdStr: string | undefined, opts: { asToken?: boolean }) => {
        const id = parseOptionalId(personIdStr, "personId");
        return opts.asToken
          ? runPersonCompaniesAsToken(client, id)
          : runPersonCompanies(client, id);
      })
    );

  registerCombinatorCommands(p, getClient, {
    base: "person-combinator",
    idFields: PERSON_MERGE_ID_FIELDS,
    entityNoun: "person",
    idLabel: "personId",
    unownedClass: true,
  });

  addOwnerOption(p.command("log <personId>"))
    .option("--limit <n>", "", cappedInt(500), 100)
    .option("--field <name>")
    .action(
      jsonAction(getClient, (client, personIdStr: string, opts: { owner?: number; limit: number; field?: string }) =>
        runPersonHistory(client, parseId(personIdStr, "personId"), opts.limit, {
          owner: opts.owner,
          field: opts.field,
        })
      )
    );
}

/** The narrowed audit row `person history` emits (see {@link projectHistoryRow}). */
export type PersonHistoryItem = ChangeHistoryItem;

/**
 * GET /api/changes/person/:personId/:ownerAsiakasId — the change-tracker audit
 * trail for one person (the same log every `--reason` write feeds). Includes
 * role grants/revokes (fieldName "asiakasPersonSetting"); pass `field` to filter
 * client-side to one fieldName. Owner defaults to the active company. The route
 * returns a RAW array (sendSuccess(changes), no .data wrapper). Auth: company
 * member or admin (BE-enforced). Mirrors runCustomerHistory.
 */
export async function runPersonHistory(
  client: ApiClient,
  personId: number,
  limit: number,
  opts: { owner?: number; field?: string } = {}
): Promise<ListEnvelope<PersonHistoryItem>> {
  const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
  const rows = await client.get<RawChangeRow[]>(
    `/api/changes/person/${personId}/${owner}?limit=${limit}`
  );
  const page = Array.isArray(rows) ? rows : [];
  // The route caps at ?limit= with no cursor, so a full page is the only "there
  // may be more" signal — and --field filters CLIENT-side over that page only,
  // so an empty filtered result on a capped page means "not in the newest
  // `limit` changes", not "never changed" (same contract as `ib log entity`, fb#376).
  const capped = page.length >= limit;
  const list = opts.field ? page.filter((r) => r.fieldName === opts.field) : page;
  const env = listEnvelope(list.map(projectHistoryRow));
  if (capped) env.truncated = true;
  if (opts.field && capped) {
    env.hint = `--field ${opts.field} was applied client-side to the newest ${limit} changes only; older changes to it are not shown. Raise --limit (max 500).`;
  }
  return env;
}

/** Pull the new personId out of newPerson's response (tolerant of legacy shapes). */
export function extractPersonId(res: unknown): number | null {
  const r = res as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const data = r.data as Record<string, unknown> | undefined;
  const candidates = [
    r.returnValue,
    data?.returnValue,
    r.personId,
    (r.recordset as Array<Record<string, unknown>> | undefined)?.[0]?.personId,
    (data?.recordset as Array<Record<string, unknown>> | undefined)?.[0]?.personId,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** True when an error is the backend's "email already in use" 400 from newPerson. */
export function isDuplicateEmailError(e: unknown): boolean {
  if (!(e instanceof CliError) || e.statusCode !== 400) return false;
  const hay = `${e.message} ${JSON.stringify(e.body ?? "")}`.toLowerCase();
  return hay.includes("käytössä") || hay.includes("already in use") || hay.includes("duplicate");
}

interface PersonByEmailRow {
  personId: number;
  personFirstName?: string;
  personLastName?: string;
  personEmail?: string;
}

/**
 * GET /api/person/getPersonByEmail/:email — look up a person by exact email
 * (proc person_getByEmail; email is globally unique, so NOT tenant-scoped).
 * Used by `person create --get-or-create` to recover the person that already
 * owns an email. Returns a tidy {personId,name,email} or null.
 */
export async function runPersonByEmail(
  client: ApiClient,
  email: string
): Promise<{ personId: number; name: string | null; email: string | null } | null> {
  const rows = await client.get<PersonByEmailRow[]>(
    `/api/person/getPersonByEmail/${encodeURIComponent(email)}`
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || !row.personId) return null;
  return {
    personId: row.personId,
    name: `${row.personFirstName || ""} ${row.personLastName || ""}`.trim() || null,
    email: row.personEmail || null,
  };
}

/**
 * POST /api/person/newPerson — create a new person record.
 * Body needs personFirstName + personLastName (+ ownerAsiakasId); personEmail
 * is optional (the column is nullable and the backend only dedupes when given).
 *
 * Response shape note: the backend wraps the result as
 * `{ status: "ok", data: { recordsets, output, rowsAffected, returnValue } }`.
 * The new personId is at `data.returnValue` — callers that need it should
 * unwrap accordingly. See `puminet5api/utils/test/test-cli-lifecycle.js` for a
 * tolerant fallback chain that handles older shapes too.
 */
export async function runPersonCreate(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/person/newPerson",
    body,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /api/person/set — partial update for an existing person.
 * `personId` is merged into the body alongside the caller's patch.
 */
export async function runPersonUpdate(
  client: ApiClient,
  personId: number,
  patch: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    "/api/person/set",
    { personId, ...patch },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * POST /api/person/setOwner/:personId — set or clear a person's ownerAsiakasId.
 * `ownerAsiakasId: null` makes the person GLOBAL (self-managing, cross-tenant
 * discoverable); a positive id assigns/moves ownership. Server-side authz applies
 * (developer = any; self → null always / → a company you belong to; company-admin
 * may release a person owned by their company → global). Write-flag headers
 * (incl. X-Dry-Run, X-Action-Reason) are forwarded.
 */
export async function runPersonSetOwner(
  client: ApiClient,
  personId: number,
  ownerAsiakasId: number | null,
  flags: WriteFlags
): Promise<unknown> {
  return client.post(
    `/api/person/setOwner/${personId}`,
    { ownerAsiakasId },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * DELETE /api/person/delete/:personId — remove a person record.
 */
export async function runPersonDelete(
  client: ApiClient,
  personId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete(
    `/api/person/delete/${personId}`,
    { headers: writeFlagsToHeaders(flags) }
  );
}
