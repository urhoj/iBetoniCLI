/**
 * `ib legal` — legal documents (dbo.legalDocuments / legalDocumentTypes).
 *
 * User-level: types / show / status (what have I agreed to). Developer or
 * sysadmin (server-enforced): versions / get / save / activate / delete /
 * acceptances. `accept` is a developer-only TESTING aid gated client-side —
 * the backend endpoint stays open because the real betoni.online/betonijerry
 * UI acceptance flows use it; real consent is a human/UI action.
 *
 * Versions are immutable: content changes always create a new version via
 * `save` (draft by default, `--activate` publishes atomically).
 */
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { parseId } from "../../targets.js";
import { decodeJwtPayload, type DecodedClaims } from "../../auth/jwt.js";
import { lineDiff } from "../../textDiff.js";
import { validateStructuredJson } from "./validateJson.js";

/** Lifecycle status values on legalDocuments.status (see backend migration). */
export const LEGAL_STATUSES = ["draft", "active", "archived", "deleted"] as const;

export interface LegalDocType {
  documentTypeId: number;
  typeName: string;
  displayName?: string;
  description?: string;
  sortOrder?: number;
  personSettingTypeId: number | null;
}

export interface LegalSaveFields {
  typeName: string;
  version: string;
  title: string;
  markdownContent: string;
  ownerAsiakasId?: number;
  notes?: string;
  effectiveDate?: string;
  activate?: boolean;
}

type Row = Record<string, unknown>;

const stripContent = (d: Row): Row => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { markdownContent, ...rest } = d;
  return rest;
};

/** markdownContent length (0 when absent) — shared by the *-meta projections. */
const contentLengthOf = (d: Row): number =>
  typeof d.markdownContent === "string" ? d.markdownContent.length : 0;

/** Strip content but report its length — the per-side meta used by `ib legal diff`. */
const diffMeta = (d: Row): Row => ({ ...stripContent(d), contentLength: contentLengthOf(d) });

export async function runLegalTypes(client: ApiClient): Promise<ListEnvelope<LegalDocType>> {
  const rows = await client.get<LegalDocType[]>("/api/legal-documents/types");
  const items = Array.isArray(rows) ? rows : [];
  return { items, nextCursor: null, count: items.length };
}

export async function runLegalShow(
  client: ApiClient,
  typeName: string,
  metaOnly: boolean
): Promise<Row> {
  const doc = await client.get<Row>(
    `/api/legal-documents/current/${encodeURIComponent(typeName)}`
  );
  if (metaOnly && doc && typeof doc === "object") return diffMeta(doc);
  return doc;
}

/**
 * Roll-up of the current ACTIVE document of EVERY type — fills the gap that
 * `types` lists types and `show` covers one type, but nothing answers "what is
 * live right now across all types". Client-side fan-out over the two existing
 * read endpoints (no dedicated backend route). One row per type so types with
 * no active version are visible (`hasActive:false`) rather than silently
 * dropped. Content is stripped (reported as `contentLength`) — read a body via
 * `ib legal show <typeName>`.
 */
export async function runLegalActive(client: ApiClient): Promise<ListEnvelope<Row>> {
  const types = await runLegalTypes(client);
  const items = await Promise.all(
    types.items.map(async (t): Promise<Row> => {
      const base: Row = {
        typeName: t.typeName,
        displayName: t.displayName ?? null,
        personSettingTypeId: t.personSettingTypeId,
      };
      try {
        const doc = await client.get<Row>(
          `/api/legal-documents/current/${encodeURIComponent(t.typeName)}`
        );
        return {
          ...base,
          hasActive: true,
          documentId: doc.documentId ?? null,
          version: doc.version ?? null,
          title: doc.title ?? null,
          effectiveDate: doc.effectiveDate ?? null,
          contentLength: contentLengthOf(doc),
        };
      } catch (e) {
        // 404 = this type has no active document; any other status is a real error.
        if (e instanceof CliError && e.statusCode === 404) {
          return {
            ...base,
            hasActive: false,
            documentId: null,
            version: null,
            title: null,
            effectiveDate: null,
            contentLength: null,
          };
        }
        throw e;
      }
    })
  );
  return { items, nextCursor: null, count: items.length };
}

export async function runLegalStatus(
  client: ApiClient,
  personId: number,
  ownerAsiakasId: number | null
): Promise<{
  personId: number;
  ownerAsiakasId: number | null;
  requiresAcceptance: boolean;
  accepted: Row[];
  missing: Row[];
}> {
  const q = ownerAsiakasId != null ? `?ownerAsiakasId=${ownerAsiakasId}` : "";
  const data = await client.get<{
    missingAcceptances?: Row[];
    acceptedAcceptances?: Row[];
    requiresAcceptance: boolean;
  }>(`/api/legal-documents/check-acceptances/${personId}${q}`);
  // markdownContent on missing docs can exceed 10 KB each — `ib legal show` reads content.
  return {
    personId,
    ownerAsiakasId,
    requiresAcceptance: data.requiresAcceptance === true,
    accepted: (data.acceptedAcceptances ?? []).map(stripContent),
    missing: (data.missingAcceptances ?? []).map(stripContent),
  };
}

export async function runLegalVersions(
  client: ApiClient,
  typeName: string,
  ownerAsiakasId?: number,
  status?: string
): Promise<ListEnvelope<Row>> {
  const q = ownerAsiakasId != null ? `?ownerAsiakasId=${ownerAsiakasId}` : "";
  const rows = await client.get<Row[]>(
    `/api/legal-documents/${encodeURIComponent(typeName)}/versions${q}`
  );
  let items = (Array.isArray(rows) ? rows : []).map(stripContent);
  // Client-side lifecycle filter — the backend returns the full history.
  if (status) items = items.filter((r) => r.status === status);
  return { items, nextCursor: null, count: items.length };
}

/**
 * Unpublished DRAFT versions across EVERY type — the cross-type answer to "is
 * anything staged to publish?". `active` rolls up live docs; this rolls up
 * drafts. Client-side fan-out over `types` + `versions` (the per-type cached
 * read), filtered to status='draft'. Content is stripped (read a body via
 * `ib legal get <documentId>` or compare with `ib legal diff`).
 */
export async function runLegalDrafts(client: ApiClient): Promise<ListEnvelope<Row>> {
  const types = await runLegalTypes(client);
  const perType = await Promise.all(
    types.items.map((t) => runLegalVersions(client, t.typeName, undefined, "draft").then((v) => v.items))
  );
  const items = perType.flat();
  return { items, nextCursor: null, count: items.length };
}

export async function runLegalGet(client: ApiClient, documentId: number): Promise<Row> {
  return client.get<Row>(`/api/legal-documents/document/${documentId}`);
}

/**
 * Line diff between two document versions. Two modes:
 *  - explicit `{ a, b }` documentIds — diff a (old) vs b (new);
 *  - `{ type, owner? }` — resolve the type's current ACTIVE (old) vs its newest
 *    DRAFT (new), i.e. "what would change if I publish the pending draft".
 *    `owner` scopes the version lookup to one tenant so a global active and a
 *    tenant-specific draft of the same type are not diffed across scopes.
 *
 * Computes the diff locally and returns only the changed hunks + counts, so the
 * two full bodies never enter the caller's context. The action validates that
 * exactly one mode is supplied.
 */
export async function runLegalDiff(
  client: ApiClient,
  input: { a: number; b: number } | { type: string; owner?: number }
): Promise<Row> {
  let docA: Row;
  let docB: Row;
  if ("type" in input) {
    const versions = await runLegalVersions(client, input.type, input.owner);
    const active = versions.items.find((r) => r.status === "active");
    const draft = versions.items.find((r) => r.status === "draft"); // newest first (createdTime DESC)
    if (!active) {
      throw new CliError(`Type "${input.type}" has no active version to diff against`, 404, null, 5);
    }
    if (!draft) {
      throw new CliError(`Type "${input.type}" has no draft version to diff`, 404, null, 5);
    }
    docA = await runLegalGet(client, Number(active.documentId));
    docB = await runLegalGet(client, Number(draft.documentId));
  } else {
    docA = await runLegalGet(client, input.a);
    docB = await runLegalGet(client, input.b);
  }
  const contentA = typeof docA.markdownContent === "string" ? docA.markdownContent : "";
  const contentB = typeof docB.markdownContent === "string" ? docB.markdownContent : "";
  const diff = lineDiff(contentA, contentB);
  return {
    a: diffMeta(docA),
    b: diffMeta(docB),
    sameContent: diff.sameContent,
    addedLines: diff.addedLines,
    removedLines: diff.removedLines,
    unified: diff.unified,
  };
}

export async function resolveDocumentType(
  client: ApiClient,
  typeName: string
): Promise<LegalDocType> {
  const types = await client.get<LegalDocType[]>("/api/legal-documents/types");
  const list = Array.isArray(types) ? types : [];
  const t = list.find((x) => x.typeName === typeName);
  if (!t) {
    throw new CliError(
      `Unknown document type "${typeName}". Valid: ${list.map((x) => x.typeName).join(", ")}`,
      404,
      null,
      5
    );
  }
  return t;
}

export async function runLegalSave(
  client: ApiClient,
  fields: LegalSaveFields,
  flags: WriteFlags
): Promise<unknown> {
  const t = await resolveDocumentType(client, fields.typeName);
  const body = {
    documentTypeId: t.documentTypeId,
    version: fields.version,
    title: fields.title,
    markdownContent: fields.markdownContent,
    notes: fields.notes,
    activate: !!fields.activate,
    ownerAsiakasId: fields.ownerAsiakasId ?? null,
    effectiveDate: fields.effectiveDate,
  };
  return client.post<unknown>("/api/legal-documents/save", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export async function runLegalActivate(
  client: ApiClient,
  documentId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.put<unknown>(`/api/legal-documents/activate/${documentId}`, {}, {
    headers: writeFlagsToHeaders(flags),
  });
}

export async function runLegalDelete(
  client: ApiClient,
  documentId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete<unknown>(`/api/legal-documents/${documentId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

export async function runLegalAcceptances(
  client: ApiClient,
  typeName: string,
  opts: { version?: string; limit?: number }
): Promise<ListEnvelope<Row> & { typeName: string; personSettingTypeId: number }> {
  const params = new URLSearchParams();
  if (opts.version) params.set("version", opts.version);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const data = await client.get<{
    typeName: string;
    personSettingTypeId: number;
    count: number;
    truncated: boolean;
    acceptances: Row[];
  }>(`/api/legal-documents/acceptances/${encodeURIComponent(typeName)}${qs ? `?${qs}` : ""}`);
  return {
    items: data.acceptances ?? [],
    nextCursor: null,
    count: data.count ?? (data.acceptances ?? []).length,
    // Always-present boolean (list-envelope convention for capped lists).
    truncated: !!data.truncated,
    typeName: data.typeName,
    personSettingTypeId: data.personSettingTypeId,
  };
}

export interface LegalTypeFields {
  displayName?: string;
  description?: string;
  sortOrder?: number;
  personSettingTypeId?: number;
}

/** Map CLI flags → API body fields; only flags the user actually passed. */
export function pickTypeFields(opts: {
  displayName?: string;
  description?: string;
  sortOrder?: number;
  settingTypeId?: number;
}): LegalTypeFields {
  const fields: LegalTypeFields = {};
  if (opts.displayName !== undefined) fields.displayName = opts.displayName;
  if (opts.description !== undefined) fields.description = opts.description;
  if (opts.sortOrder !== undefined) fields.sortOrder = opts.sortOrder;
  if (opts.settingTypeId !== undefined) fields.personSettingTypeId = opts.settingTypeId;
  return fields;
}

export async function runLegalTypeCreate(
  client: ApiClient,
  typeName: string,
  fields: LegalTypeFields,
  flags: WriteFlags
): Promise<Row> {
  return client.post<Row>(
    "/api/legal-documents/types",
    { typeName, ...fields },
    { headers: writeFlagsToHeaders(flags) }
  );
}

export async function runLegalTypeUpdate(
  client: ApiClient,
  typeName: string,
  fields: LegalTypeFields,
  flags: WriteFlags
): Promise<Row> {
  if (Object.keys(fields).length === 0) {
    throw new CliError(
      "nothing to update: pass at least one of --display-name / --description / --sort-order / --setting-type-id",
      0,
      null,
      4
    );
  }
  return client.put<Row>(
    `/api/legal-documents/types/${encodeURIComponent(typeName)}`,
    fields,
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * `accept` takes its typeName positionally like its siblings (show / versions /
 * acceptances), with --type kept as an alias (feedback #32). Exactly one is
 * required; both are allowed only when they agree.
 */
export function resolveTypeNameTarget(
  positional: string | undefined,
  flag: string | undefined
): string {
  const name = positional ?? flag;
  if (!name) {
    failWith("missing document type: pass <typeName> positionally or via --type <typeName>", 4);
  }
  if (positional !== undefined && flag !== undefined && positional !== flag) {
    failWith(`positional typeName (${positional}) and --type (${flag}) differ — pass only one`, 4);
  }
  return name;
}

/** Client-side dev-gate for `accept` — the endpoint itself stays user-open (FE flows). */
export function assertDeveloperClaims(claims: DecodedClaims): void {
  if (!claims.isDeveloper && !claims.isSystemAdmin) {
    failWith(
      "ib legal accept is a developer/sysadmin testing aid. Real consent is recorded via the betoni.online / betonijerry.fi UI.",
      3
    );
  }
}

export async function runLegalAccept(
  client: ApiClient,
  typeName: string,
  personId: number,
  flags: WriteFlags
): Promise<unknown> {
  const doc = await client.get<Row>(
    `/api/legal-documents/current/${encodeURIComponent(typeName)}`
  ); // 404 (no active doc) -> exit 5 via CliError
  const t = await resolveDocumentType(client, typeName);
  if (!t.personSettingTypeId) {
    failWith(
      `Type ${typeName} has no personSettingTypeId mapping — acceptance cannot be tracked`,
      4
    );
  }
  const body = {
    personId,
    documentId: doc.documentId,
    settingTypeId: t.personSettingTypeId,
    version: doc.version,
  };
  return client.post<unknown>("/api/legal-documents/record-acceptance", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export function registerLegalCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const legal = parent
    .command("legal")
    .description("Legal documents — what you have agreed to + developer document management");

  legal
    .command("types")
    .description("List legal document types (GET /api/legal-documents/types)")
    .action(async () => {
      try {
        const client = await getClient();
        writeJson(await runLegalTypes(client));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("show <typeName>")
    .description("Current ACTIVE document of a type, incl. markdown content")
    .option("--meta", "Omit markdownContent (returns contentLength instead)")
    .action(async (typeName: string, opts: { meta?: boolean }) => {
      try {
        const client = await getClient();
        writeJson(await runLegalShow(client, typeName, !!opts.meta));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("active")
    .alias("list")
    .description("Current ACTIVE document of EVERY type (one row per type; hasActive:false where none)")
    .action(async () => {
      try {
        const client = await getClient();
        writeJson(await runLegalActive(client));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("status")
    .description("Which legal documents you have accepted / still need to accept")
    .option("--person <id>", "Check another person (developer/sysadmin only)", Number)
    .option("--owner <id>", "ownerAsiakasId scope (default: your company from the token)", Number)
    .action(async (opts: { person?: number; owner?: number }) => {
      try {
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        const personId =
          opts.person ??
          claims.personId ??
          failWith("could not resolve personId from the active token — pass --person <id>", 4);
        const owner = opts.owner ?? claims.ownerAsiakasId ?? null;
        writeJson(await runLegalStatus(client, personId, owner));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("versions <typeName>")
    .description("All versions of a document type (active + drafts + history); each row carries status")
    .option("--owner <id>", "Filter by ownerAsiakasId tenant scope", Number)
    .option("--status <status>", `Filter by lifecycle status (${LEGAL_STATUSES.join("|")})`)
    .action(async (typeName: string, opts: { owner?: number; status?: string }) => {
      try {
        if (opts.status && !LEGAL_STATUSES.includes(opts.status as (typeof LEGAL_STATUSES)[number])) {
          failWith(`Invalid --status "${opts.status}". Valid: ${LEGAL_STATUSES.join(", ")}`, 4);
        }
        const client = await getClient();
        writeJson(await runLegalVersions(client, typeName, opts.owner, opts.status));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("drafts")
    .description("Unpublished DRAFT versions across all types (status='draft'; content stripped)")
    .action(async () => {
      try {
        const client = await getClient();
        writeJson(await runLegalDrafts(client));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("diff [a] [b]")
    .description("Line diff: two documentIds (<a> old, <b> new), or --type (newest draft vs active)")
    .option("--type <typeName>", "Diff the newest DRAFT vs the current ACTIVE version of this type")
    .option("--owner <id>", "ownerAsiakasId scope for --type resolution (e.g. 1349 = BetoniJerry)", Number)
    .action(async (aStr: string | undefined, bStr: string | undefined, opts: { type?: string; owner?: number }) => {
      try {
        let input: { a: number; b: number } | { type: string; owner?: number };
        if (opts.type) {
          if (aStr !== undefined || bStr !== undefined) {
            failWith("pass either <a> <b> documentIds OR --type <name>, not both", 4);
          }
          input = { type: opts.type, owner: opts.owner };
        } else {
          if (opts.owner !== undefined) failWith("--owner only applies with --type", 4);
          if (aStr === undefined || bStr === undefined) {
            failWith("provide two positive documentIds (<a> <b>) or use --type <name>", 4);
          }
          const a = parseId(aStr, "version");
          const b = parseId(bStr, "version");
          input = { a, b };
        }
        const client = await getClient();
        writeJson(await runLegalDiff(client, input));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("get <documentId>")
    .description("One document version by id, incl. markdown content")
    .action(async (documentIdStr: string) => {
      const documentId = parseId(documentIdStr, "documentId");
      try {
        const client = await getClient();
        writeJson(await runLegalGet(client, documentId));
      } catch (e) {
        exitWithError(e);
      }
    });

  const saveCmd = legal
    .command("save")
    .description("Create a NEW document version (immutable; draft unless --activate)")
    .requiredOption("--type <typeName>", "Document type name (see ib legal types)")
    // NOT --version: the root global -V/--version is recognised anywhere in argv
    // and would shadow it (enforced by the root-option reuse test in
    // test/reference/help-wiring.test.ts).
    .requiredOption("--doc-version <v>", "Version string, e.g. 2.0")
    .requiredOption("--title <title>", "Document title")
    .option("--file <path>", "Read markdown content from a local file")
    .option("--content <markdown>", "Inline markdown content (use over /api/cli/exec — no local FS there)")
    .option("--owner <id>", "ownerAsiakasId tenant scope (e.g. 1349 = BetoniJerry); omit for global", Number)
    .option("--notes <text>", "Internal notes")
    .option("--effective-date <date>", "Effective date YYYY-MM-DD (default: now)")
    .option("--activate", "Publish immediately (deactivates prior versions). Default: inactive draft")
    .option("--validate-json", "Validate the embedded ```json block parses to an object before saving (recommended for BETONIJERRY_* structured types)");
  addWriteFlagsToCommand(saveCmd).action(
    async (opts: {
      type: string;
      docVersion: string;
      title: string;
      file?: string;
      content?: string;
      owner?: number;
      notes?: string;
      effectiveDate?: string;
      activate?: boolean;
      validateJson?: boolean;
      dryRun?: boolean;
      reason?: string;
      idempotencyKey?: string;
    }) => {
      if (!opts.file && !opts.content) failWith("Provide --file <path> or --content <markdown>", 4);
      if (opts.file && opts.content) failWith("--file and --content are mutually exclusive", 4);
      if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
      let markdownContent = opts.content ?? "";
      if (opts.file) {
        try {
          markdownContent = await readFile(opts.file, "utf8");
        } catch {
          failWith(`Cannot read file: ${opts.file}`, 4);
        }
      }
      if (opts.validateJson) {
        const v = validateStructuredJson(markdownContent);
        if (!v.ok) failWith(`--validate-json failed: ${v.error}`, 4);
      }
      try {
        const client = await getClient();
        writeJson(
          await runLegalSave(
            client,
            {
              typeName: opts.type,
              version: opts.docVersion,
              title: opts.title,
              markdownContent,
              ownerAsiakasId: opts.owner,
              notes: opts.notes,
              effectiveDate: opts.effectiveDate,
              activate: !!opts.activate,
            },
            { dryRun: opts.dryRun, reason: opts.reason, idempotencyKey: opts.idempotencyKey }
          )
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const activateCmd = legal
    .command("activate <documentId>")
    .description("Publish a version: atomically archives the current active, activates this one");
  addWriteFlagsToCommand(activateCmd).action(
    async (documentIdStr: string, opts: { dryRun?: boolean; reason?: string; idempotencyKey?: string }) => {
      const documentId = parseId(documentIdStr, "documentId");
      if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
      try {
        const client = await getClient();
        writeJson(await runLegalActivate(client, documentId, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const deleteCmd = legal
    .command("delete <documentId>")
    .description("Soft-delete (deactivate) a document version");
  addWriteFlagsToCommand(deleteCmd).action(
    async (documentIdStr: string, opts: { dryRun?: boolean; reason?: string; idempotencyKey?: string }) => {
      const documentId = parseId(documentIdStr, "documentId");
      if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
      try {
        const client = await getClient();
        writeJson(await runLegalDelete(client, documentId, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  legal
    .command("acceptances <typeName>")
    .description("Compliance report: WHO has accepted a document type (developer/sysadmin)")
    // NOT --version: shadowed by the root global -V/--version (enforced by the
    // root-option reuse test in test/reference/help-wiring.test.ts).
    .option("--doc-version <v>", "Only acceptances of this version string")
    .option("--limit <n>", "Max rows (default 500, cap 500)", (v: string) => Math.min(Number(v), 500))
    .action(async (typeName: string, opts: { docVersion?: string; limit?: number }) => {
      try {
        const client = await getClient();
        writeJson(
          await runLegalAcceptances(client, typeName, {
            version: opts.docVersion,
            limit: opts.limit,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  const acceptCmd = legal
    .command("accept [typeName]")
    .description("Record YOUR OWN acceptance of the current active version (developer testing aid)")
    .option("--type <typeName>", "Document type name (alias for the positional)");
  addWriteFlagsToCommand(acceptCmd).action(
    async (
      typeNameArg: string | undefined,
      opts: { type?: string; dryRun?: boolean; reason?: string; idempotencyKey?: string }
    ) => {
      try {
        const typeName = resolveTypeNameTarget(typeNameArg, opts.type);
        if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        assertDeveloperClaims(claims);
        const personId =
          claims.personId ??
          failWith("could not resolve personId from the active token", 4);
        writeJson(await runLegalAccept(client, typeName, personId, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const typeGroup = legal
    .command("type")
    .description("Legal document TYPE management — create types, fix acceptance mappings (developer/sysadmin)");

  const typeCreateCmd = typeGroup
    .command("create")
    .description("Create a new legal document type")
    .requiredOption("--name <typeName>", "Type name, UPPER_SNAKE, max 50 (e.g. TOS_EN); immutable after creation")
    .requiredOption("--display-name <s>", "Human-readable name (max 100)")
    .option("--description <s>", "Short description (max 200)")
    .option("--sort-order <n>", "List position (default 0)", Number)
    .option("--setting-type-id <n>", "personSettingTypeId for acceptance tracking (must exist and be unmapped)", Number);
  addWriteFlagsToCommand(typeCreateCmd).action(
    async (opts: {
      name: string;
      displayName: string;
      description?: string;
      sortOrder?: number;
      settingTypeId?: number;
      dryRun?: boolean;
      reason?: string;
      idempotencyKey?: string;
    }) => {
      try {
        if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
        const client = await getClient();
        writeJson(await runLegalTypeCreate(client, opts.name, pickTypeFields(opts), opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  const typeUpdateCmd = typeGroup
    .command("update <typeName>")
    .description("Update a type's editable fields (typeName itself is immutable)")
    .option("--display-name <s>", "Human-readable name (max 100)")
    .option("--description <s>", "Short description (max 200)")
    .option("--sort-order <n>", "List position", Number)
    .option("--setting-type-id <n>", "personSettingTypeId for acceptance tracking (must exist and be unmapped)", Number);
  addWriteFlagsToCommand(typeUpdateCmd).action(
    async (
      typeName: string,
      opts: {
        displayName?: string;
        description?: string;
        sortOrder?: number;
        settingTypeId?: number;
        dryRun?: boolean;
        reason?: string;
        idempotencyKey?: string;
      }
    ) => {
      try {
        if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
        const client = await getClient();
        writeJson(await runLegalTypeUpdate(client, typeName, pickTypeFields(opts), opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
