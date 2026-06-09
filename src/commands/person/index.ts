import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { roleNameForTypeId, resolveRoleTypeId } from "../../roles.js";
import { runCompanyList } from "../company/index.js";
import { CliError } from "../../api/errors.js";

export interface PersonListFilter {
  role?: string;
  asiakas?: number;
  limit?: number;
}

/** Typed convenience fields for `person create`, mapped to backend column names. */
export interface PersonCreateFlags {
  first?: string;
  last?: string;
  phone?: string;
  /** Optional — the DB and backend accept a person with no email (phone-only contacts). */
  email?: string;
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
  if (typed.asiakas !== undefined) body.ownerAsiakasId = typed.asiakas;
  if (typed.global) body.ownerAsiakasId = null;
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
  const params = new URLSearchParams();
  if (opts.role) params.set("role", opts.role);
  if (opts.asiakas !== undefined) params.set("asiakas", String(opts.asiakas));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return client.get<ListEnvelope<Record<string, unknown>>>(
    `/api/cli/person/list${qs ? `?${qs}` : ""}`
  );
}

/**
 * GET /api/cli/person/get/:personId. Returns the flat backend record as-is.
 */
export async function runPersonGet(
  client: ApiClient,
  personId: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(
    `/api/cli/person/get/${personId}`
  );
}

/**
 * POST /api/person/search — existing (non-/api/cli/) route used by the FE
 * person typeahead. Body is `{ searchString: <query> }`. The backend scopes
 * results to the caller's company (req.user.ownerAsiakasId) when no
 * ownerAsiakasId is in the body, so the CLI sends only searchString. Result
 * shape is whatever the backend returns (typically an array of person records).
 */
export async function runPersonSearch(
  client: ApiClient,
  query: string,
  limit?: number
): Promise<unknown> {
  const body: Record<string, unknown> = { searchString: query };
  if (limit !== undefined) body.limit = limit;
  return client.post<unknown>("/api/person/search", body);
}

/** A person hit from the cross-company search, tagged with its company. */
export interface MyCompanyPersonHit {
  personId: number;
  name: string;
  email: string | null;
  phone: string | null;
  asiakasId: number;
  asiakasName: string;
}

/**
 * /api/person/search returns either a bare array of person rows or a raw mssql
 * result wrapper ({ recordset } / { recordsets: [[...]] }) depending on cache
 * warmth. Normalise both to a flat array of row objects.
 */
export function extractPersonRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const obj = raw as { recordset?: unknown; recordsets?: unknown };
    if (Array.isArray(obj.recordset)) {
      return obj.recordset as Record<string, unknown>[];
    }
    if (Array.isArray(obj.recordsets) && Array.isArray(obj.recordsets[0])) {
      return obj.recordsets[0] as Record<string, unknown>[];
    }
  }
  return [];
}

/**
 * Fan a person search out across the caller's companies (`--my-companies`).
 * `listCompanies` yields the companies to sweep; `searchIn(asiakasId)` runs the
 * search in one company (the caller binds the query + an ephemeral per-company
 * client). Each hit is projected to a clean, company-tagged row and merged into
 * one ListEnvelope so cross-company results are disambiguable.
 */
export async function runPersonSearchMyCompanies(
  listCompanies: () => Promise<{ asiakasId: number; name: string }[]>,
  searchIn: (asiakasId: number) => Promise<unknown>
): Promise<ListEnvelope<MyCompanyPersonHit>> {
  const companies = await listCompanies();
  const items: MyCompanyPersonHit[] = [];
  for (const c of companies) {
    const raw = await searchIn(c.asiakasId);
    for (const row of extractPersonRows(raw)) {
      const first = (row.personFirstName as string) ?? "";
      const last = (row.personLastName as string) ?? "";
      items.push({
        personId: Number(row.personId),
        name: `${first} ${last}`.trim(),
        email: (row.personEmail as string) ?? null,
        phone: (row.personPhone as string) ?? null,
        asiakasId: c.asiakasId,
        asiakasName: c.name,
      });
    }
  }
  return { items, nextCursor: null, count: items.length };
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
  return { items, nextCursor: null, count: items.length };
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
  return client.post(
    `/api/asiakasPersonSettings/add/${asiakasId}/${personId}/${roleTypeId}`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
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
  roles: { roleTypeId: number; role: string | null }[];
  companies: { asiakasId: number; name: string; current: boolean }[];
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
  const claims = decodeJwtPayload(client.getCurrentToken());
  const [profile, available] = await Promise.all([
    client.get<{
      personId: number; name: string | null; email: string | null; phone: string | null; roles: number[];
    }>(`/api/cli/person/get/${claims.personId}`),
    client.get<{
      companies: { asiakasId: number; asiakasNimi?: string; name?: string }[]; currentCompanyId: number;
    }>(`/api/company-selection/available`),
  ]);
  const companies = available.companies || [];
  const active = companies.find((c) => c.asiakasId === available.currentCompanyId);
  return {
    personId: claims.personId,
    name: profile.name ?? null,
    email: profile.email ?? claims.email ?? null,
    phone: profile.phone ?? null,
    activeCompany: {
      asiakasId: available.currentCompanyId,
      name: active?.asiakasNimi ?? active?.name ?? null,
    },
    roles: (profile.roles || []).map((t) => ({ roleTypeId: t, role: roleNameForTypeId(t) })),
    companies: companies.map((c) => ({
      asiakasId: c.asiakasId,
      name: c.asiakasNimi ?? c.name ?? "",
      current: c.asiakasId === available.currentCompanyId,
    })),
  };
}

interface UserAsiakasRow {
  asiakasId: number;
  // Backend returns the Finnish `asiakasNimi`; older callers may have used these.
  asiakasNimi?: string;
  asiakasName?: string;
  name?: string;
}

/**
 * `ib person companies [personId]` — the customers a person belongs to (reverse
 * of `customer person list`). personId defaults to the caller (from the JWT).
 * GET /api/person/getUserAsiakasList/:personId; defensive unwrap of mssql shapes.
 */
export async function runPersonCompanies(
  client: ApiClient,
  personId?: number
): Promise<ListEnvelope<{ asiakasId: number; name: string | null }>> {
  const id = personId ?? decodeJwtPayload(client.getCurrentToken()).personId;
  const raw = await client.get<
    UserAsiakasRow[] | { recordset?: UserAsiakasRow[]; recordsets?: UserAsiakasRow[][] }
  >(`/api/person/getUserAsiakasList/${id}`);
  let rows: UserAsiakasRow[] = [];
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && typeof raw === "object") {
    rows = raw.recordset || raw.recordsets?.[0] || [];
  }
  const items = rows.map((r) => ({ asiakasId: r.asiakasId, name: r.asiakasNimi ?? r.asiakasName ?? r.name ?? null }));
  return { items, nextCursor: null, count: items.length };
}

/**
 * Register `ib person` read subcommands on the parent commander instance:
 *   - list    filterable by --role/--asiakas/--limit
 *   - get     single person by personId
 *   - search  free-text search (existing POST /api/person/search route)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerPersonCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  getClientForAsiakas: (asiakasId: number) => Promise<ApiClient>
): void {
  const p = parent.command("person").description("Person commands");

  p.command("list")
    .description("List persons")
    .option("--role <role>", "Filter by role name")
    .option("--asiakas <id>", "Filter by asiakasId", (v: string) => Number(v))
    .option("--limit <n>", "Max rows", (v: string) => Math.min(Number(v), 500))
    .action(async (opts: PersonListFilter) => {
      try {
        const client = await getClient();
        const result = await runPersonList(client, opts);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  p.command("get <personId>")
    .description("Get a single person by personId")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        const result = await runPersonGet(client, Number(idStr));
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  p.command("search <query>")
    .description("Free-text search for persons")
    .option("--limit <n>", "Max results", (v: string) => Math.min(Number(v), 500))
    .option(
      "--my-companies",
      "Search across every company you belong to (each hit tagged with its asiakasId)"
    )
    .action(
      async (query: string, opts: { limit?: number; myCompanies?: boolean }) => {
        try {
          const client = await getClient();
          if (opts.myCompanies) {
            const result = await runPersonSearchMyCompanies(
              async () =>
                (await runCompanyList(client)).items.map((c) => ({
                  asiakasId: c.asiakasId,
                  name: c.name,
                })),
              async (asiakasId) =>
                runPersonSearch(
                  await getClientForAsiakas(asiakasId),
                  query,
                  opts.limit
                )
            );
            writeJson(result);
            return;
          }
          const result = await runPersonSearch(client, query, opts.limit);
          writeJson(result);
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  const createCmd = p
    .command("create")
    .description(
      "Create a person. Required: --first, --last. --email is OPTIONAL (phone-only " +
        "contacts are fine; add the email later). --asiakas defaults to your active " +
        "company. Returns the created person record (clean {personId, ...}). With " +
        "--get-or-create a duplicate email returns the existing person (reused:true) " +
        "instead of failing. Use typed flags or --body JSON (typed flags win). Requires --reason."
    )
    .option("--first <s>", "personFirstName (required)")
    .option("--last <s>", "personLastName (required)")
    .option("--phone <s>", "personPhone")
    .option("--email <s>", "personEmail (optional)")
    .option("--asiakas <id>", "Owner asiakasId (defaults to your active company)", Number)
    .option(
      "--global",
      "Create a GLOBAL, self-managing person with no owner (ownerAsiakasId=null), discoverable across companies. Mutually exclusive with --asiakas."
    )
    .option(
      "--get-or-create",
      "On a duplicate email, return the existing person (reused:true) instead of failing"
    )
    .option("--body <json>", "Raw JSON body (merged under typed flags)");
  addWriteFlagsToCommand(createCmd).action(
    async (opts: WriteFlags & PersonCreateFlags & { getOrCreate?: boolean; body?: string }) => {
      if (!opts.reason) {
        writeError(new Error("Missing required flag: --reason"));
        process.exit(4);
      }
      // --global and --asiakas are mutually exclusive owner directives.
      if (opts.global && opts.asiakas !== undefined) {
        writeError(new Error("--global and --asiakas are mutually exclusive"));
        process.exit(4);
      }
      let parsed: Record<string, unknown> = {};
      if (opts.body) {
        try {
          parsed = JSON.parse(opts.body);
        } catch {
          writeError(new Error("--body must be valid JSON"));
          process.exit(4);
        }
      }
      const body = buildPersonCreateBody(parsed, {
        first: opts.first,
        last: opts.last,
        phone: opts.phone,
        email: opts.email,
        asiakas: opts.asiakas,
        global: opts.global,
      });
      const missing = missingPersonCreateFields(body);
      if (missing.length > 0) {
        writeError(new Error(`create requires: ${missing.join(", ")}`));
        process.exit(4);
      }
      try {
        const client = await getClient();
        // ownerAsiakasId is needed by person_add; default it to the active company
        // when neither --asiakas nor --body supplied one — but NOT for --global,
        // whose null owner is intentional.
        if (!opts.global && (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null)) {
          body.ownerAsiakasId = await resolveOwnerAsiakasId(client);
        }
        let res: unknown;
        try {
          res = await runPersonCreate(client, body, opts);
        } catch (e) {
          // --get-or-create: a duplicate email isn't a failure — return the
          // person that already owns it (so bulk onboarding is idempotent).
          if (opts.getOrCreate && body.personEmail && isDuplicateEmailError(e)) {
            const existing = await runPersonByEmail(client, String(body.personEmail));
            if (existing) {
              writeJson({ ...existing, reused: true });
              return;
            }
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
        const created = await runPersonGet(client, newId);
        writeJson(opts.getOrCreate ? { ...created, reused: false } : created);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    p
      .command("update <personId>")
      .description("Update a person. Body REQUIRED via --body. Requires --reason.")
      .requiredOption("--body <json>", "Patch body (JSON)")
  ).action(async (personIdStr: string, opts: WriteFlags & { body: string }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(opts.body);
    } catch {
      writeError(new Error("--body must be valid JSON"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runPersonUpdate(client, Number(personIdStr), patch, opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    p
      .command("delete <personId>")
      .description("Delete a person. Requires --reason.")
  ).action(async (personIdStr: string, opts: WriteFlags) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runPersonDelete(client, Number(personIdStr), opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  // ─── person role subgroup ────────────────────────────────────────────────
  const personRole = p
    .command("role")
    .description("Manage a person's per-company roles (asiakasPersonSettings)");

  personRole
    .command("list <personId>")
    .description("List a person's roles in a company")
    .requiredOption("--asiakas <id>", "Target asiakasId", (v: string) => Number(v))
    .action(async (personIdStr: string, opts: { asiakas: number }) => {
      try {
        const client = await getClient();
        const result = await runPersonRoleList(client, Number(personIdStr), opts.asiakas);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    personRole
      .command("grant <personId>")
      .description("Grant a role to a person in a company. Requires --role, --asiakas, --reason.")
      .requiredOption("--role <name>", "Role name (see ROLE_TYPEID_BY_NAME)")
      .requiredOption("--asiakas <id>", "Target asiakasId", (v: string) => Number(v))
  ).action(async (personIdStr: string, opts: WriteFlags & { role: string; asiakas: number }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    let roleTypeId: number;
    try {
      roleTypeId = resolveRoleTypeId(opts.role);
    } catch (validationErr) {
      writeError(validationErr);
      process.exit(4);
    }
    // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
    // must name a real role, so reject the empty-string case rather than POST a
    // bogus roleTypeId 0 to the backend.
    if (!roleTypeId) {
      writeError(new Error("--role must not be empty"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runPersonRoleGrant(client, Number(personIdStr), opts.asiakas, roleTypeId, opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    personRole
      .command("revoke <personId>")
      .description("Revoke a role from a person in a company (idempotent). Requires --role, --asiakas, --reason.")
      .requiredOption("--role <name>", "Role name (see ROLE_TYPEID_BY_NAME)")
      .requiredOption("--asiakas <id>", "Target asiakasId", (v: string) => Number(v))
  ).action(async (personIdStr: string, opts: WriteFlags & { role: string; asiakas: number }) => {
    if (!opts.reason) {
      writeError(new Error("Missing required flag: --reason"));
      process.exit(4);
    }
    let roleTypeId: number;
    try {
      roleTypeId = resolveRoleTypeId(opts.role);
    } catch (validationErr) {
      writeError(validationErr);
      process.exit(4);
    }
    // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
    // must name a real role, so reject the empty-string case rather than POST a
    // bogus roleTypeId 0 to the backend.
    if (!roleTypeId) {
      writeError(new Error("--role must not be empty"));
      process.exit(4);
    }
    try {
      const client = await getClient();
      const result = await runPersonRoleRevoke(client, Number(personIdStr), opts.asiakas, roleTypeId, opts);
      writeJson(result);
    } catch (e) {
      exitWithError(e);
    }
  });

  // ─── self-introspection ───────────────────────────────────────────────────
  p.command("me")
    .description("Your own profile, your roles across all your companies, and actable companies")
    .action(async () => {
      try {
        const client = await getClient();
        const result = await runPersonMe(client);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  p.command("companies [personId]")
    .description("List the companies a person belongs to (defaults to you)")
    .action(async (personIdStr?: string) => {
      try {
        const client = await getClient();
        const result = await runPersonCompanies(
          client,
          personIdStr ? Number(personIdStr) : undefined
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });

  p.command("history <personId>")
    .description(
      "Change-tracker audit trail for one person (who changed what, when, with --reason). " +
        "Includes role grants/revokes — pass `--field asiakasPersonSetting` for role changes only."
    )
    .option("--owner <id>", "ownerAsiakasId (default: active company)", (v: string) => Number(v))
    .option("--limit <n>", "Max rows (default 100, cap 500)", (v: string) => Math.min(Number(v), 500), 100)
    .option("--field <name>", "Filter by changeTracker fieldName (e.g. asiakasPersonSetting)")
    .action(async (personIdStr: string, opts: { owner?: number; limit: number; field?: string }) => {
      try {
        const client = await getClient();
        const result = await runPersonHistory(client, Number(personIdStr), opts.limit, {
          owner: opts.owner,
          field: opts.field,
        });
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });
}

/**
 * Resolve the caller's active ownerAsiakasId via the existing
 * /api/company-selection/available route (same pattern as customer/sijainti
 * create). Throws a clear error if no active company resolves.
 */
async function resolveOwnerAsiakasId(client: ApiClient): Promise<number> {
  const available = await client.get<{ currentCompanyId?: number }>(
    "/api/company-selection/available"
  );
  if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
    throw new Error(
      "could not resolve active company — run `ib auth switch` or pass --asiakas / ownerAsiakasId in --body"
    );
  }
  return available.currentCompanyId;
}

interface RawPersonChangeRow {
  changeId: number;
  fieldName?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  changeType?: string | null;
  personId?: number | null;
  personFullName?: string | null;
  timestamp?: string | null;
  description?: string | null;
  reason?: string | null;
}

export interface PersonHistoryItem {
  changeId: number;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changeType: string | null;
  personId: number | null;
  personName: string | null;
  at: string | null;
  description: string | null;
  reason: string | null;
}

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
  const owner = opts.owner ?? (await resolveOwnerAsiakasId(client));
  const rows = await client.get<RawPersonChangeRow[]>(
    `/api/changes/person/${personId}/${owner}?limit=${limit}`
  );
  let list = Array.isArray(rows) ? rows : [];
  if (opts.field) list = list.filter((r) => r.fieldName === opts.field);
  return {
    items: list.map((r) => ({
      changeId: r.changeId,
      field: r.fieldName ?? null,
      oldValue: r.oldValue ?? null,
      newValue: r.newValue ?? null,
      changeType: r.changeType ?? null,
      personId: r.personId ?? null,
      personName: r.personFullName ?? null,
      at: r.timestamp ?? null,
      description: r.description ?? null,
      reason: r.reason ?? null,
    })),
    nextCursor: null,
    count: list.length,
  };
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
