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
import { decodeJwtPayload, type DecodedClaims } from "../../auth/jwt.js";

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
  if (metaOnly && doc && typeof doc === "object") {
    const len =
      typeof doc.markdownContent === "string" ? doc.markdownContent.length : 0;
    return { ...stripContent(doc), contentLength: len };
  }
  return doc;
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
  ownerAsiakasId?: number
): Promise<ListEnvelope<Row>> {
  const q = ownerAsiakasId != null ? `?ownerAsiakasId=${ownerAsiakasId}` : "";
  const rows = await client.get<Row[]>(
    `/api/legal-documents/${encodeURIComponent(typeName)}/versions${q}`
  );
  const items = (Array.isArray(rows) ? rows : []).map(stripContent);
  return { items, nextCursor: null, count: items.length };
}

export async function runLegalGet(client: ApiClient, documentId: number): Promise<Row> {
  return client.get<Row>(`/api/legal-documents/document/${documentId}`);
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
  const out: ListEnvelope<Row> & { typeName: string; personSettingTypeId: number } = {
    items: data.acceptances ?? [],
    nextCursor: null,
    count: data.count ?? (data.acceptances ?? []).length,
    typeName: data.typeName,
    personSettingTypeId: data.personSettingTypeId,
  };
  if (data.truncated) out.truncated = true;
  return out;
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
    .command("status")
    .description("Which legal documents you have accepted / still need to accept")
    .option("--person <id>", "Check another person (developer/sysadmin only)", Number)
    .option("--owner <id>", "ownerAsiakasId scope (default: your company from the token)", Number)
    .action(async (opts: { person?: number; owner?: number }) => {
      try {
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        const personId = opts.person ?? claims.personId;
        const owner = opts.owner ?? claims.ownerAsiakasId ?? null;
        writeJson(await runLegalStatus(client, personId, owner));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("versions <typeName>")
    .description("All versions of a document type (active + drafts + history)")
    .option("--owner <id>", "Filter by ownerAsiakasId tenant scope", Number)
    .action(async (typeName: string, opts: { owner?: number }) => {
      try {
        const client = await getClient();
        writeJson(await runLegalVersions(client, typeName, opts.owner));
      } catch (e) {
        exitWithError(e);
      }
    });

  legal
    .command("get <documentId>")
    .description("One document version by id, incl. markdown content")
    .action(async (documentIdStr: string) => {
      const documentId = Number(documentIdStr);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        failWith(`Invalid documentId "${documentIdStr}"`, 4);
      }
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
    // and would shadow it (see help-wiring "no root collision" test).
    .requiredOption("--doc-version <v>", "Version string, e.g. 2.0")
    .requiredOption("--title <title>", "Document title")
    .option("--file <path>", "Read markdown content from a local file")
    .option("--content <markdown>", "Inline markdown content (use over /api/cli/exec — no local FS there)")
    .option("--owner <id>", "ownerAsiakasId tenant scope (e.g. 1349 = BetoniJerry); omit for global", Number)
    .option("--notes <text>", "Internal notes")
    .option("--effective-date <date>", "Effective date YYYY-MM-DD (default: now)")
    .option("--activate", "Publish immediately (deactivates prior versions). Default: inactive draft");
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
    .description("Publish a version: atomically deactivates siblings, activates this one");
  addWriteFlagsToCommand(activateCmd).action(
    async (documentIdStr: string, opts: { dryRun?: boolean; reason?: string; idempotencyKey?: string }) => {
      const documentId = Number(documentIdStr);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        failWith(`Invalid documentId "${documentIdStr}"`, 4);
      }
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
      const documentId = Number(documentIdStr);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        failWith(`Invalid documentId "${documentIdStr}"`, 4);
      }
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
    // NOT --version: shadowed by the root global -V/--version (see save above).
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
    .command("accept")
    .description("Record YOUR OWN acceptance of the current active version (developer testing aid)")
    .requiredOption("--type <typeName>", "Document type name to accept");
  addWriteFlagsToCommand(acceptCmd).action(
    async (opts: { type: string; dryRun?: boolean; reason?: string; idempotencyKey?: string }) => {
      if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
      try {
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        assertDeveloperClaims(claims);
        writeJson(await runLegalAccept(client, opts.type, claims.personId, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
