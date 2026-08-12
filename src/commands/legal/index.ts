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
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson, failWith, failUsage } from "../../output/json.js";
import { parseId, cappedInt, assertEnum } from "../../targets.js";
import { decodeJwtPayload, type DecodedClaims } from "../../auth/jwt.js";
import { lineDiff } from "../../textDiff.js";
import { addEditFlags, applyTextEdit, parseEditOp, textEditDryRunEnvelope, type TextEditOp } from "../../textEdit.js";
import { validateStructuredJson } from "./validateJson.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
import { bothInOrder } from "../../parallel.js";

/** Lifecycle status values on legalDocuments.status (see backend migration). */
export const LEGAL_STATUSES = ["draft", "active", "archived", "deleted"] as const;

/**
 * Document language values on legalDocuments.language (Task 8 backend). `fi`
 * is the binding original; `en` is an unofficial translation — the backend
 * falls back to the `fi` row when no active `en` row exists for a type.
 */
export const LEGAL_LANGUAGES = ["fi", "en"] as const;

/** Normalize --language to a validated lowercase fi|en, defaulting to fi (the binding original) when omitted. Exits 4 on a bad code. */
export function normalizeLegalLanguage(lang: string | undefined): string {
  const v = (lang ?? "fi").trim().toLowerCase();
  assertEnum(v, LEGAL_LANGUAGES, "--language");
  return v;
}

const LANGUAGE_FLAG_DESC = "Document language: fi (binding) or en (unofficial translation). Default fi.";

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
  /** Document language (fi|en). Omitted = backend default (fi). */
  language?: string;
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
  return listEnvelope(items);
}

export async function runLegalShow(
  client: ApiClient,
  typeName: string,
  metaOnly: boolean,
  language?: string
): Promise<Row> {
  const suffix = qs({ language: language || undefined });
  const doc = await client.get<Row>(
    `/api/legal-documents/current/${encodeURIComponent(typeName)}${suffix}`
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
export async function runLegalActive(client: ApiClient, language?: string): Promise<ListEnvelope<Row>> {
  const types = await runLegalTypes(client);
  const suffix = qs({ language: language || undefined });
  const items = await Promise.all(
    types.items.map(async (t): Promise<Row> => {
      const base: Row = {
        typeName: t.typeName,
        displayName: t.displayName ?? null,
        personSettingTypeId: t.personSettingTypeId,
      };
      try {
        const doc = await client.get<Row>(
          `/api/legal-documents/current/${encodeURIComponent(t.typeName)}${suffix}`
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
  return listEnvelope(items);
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
  status?: string,
  language?: string
): Promise<ListEnvelope<Row>> {
  const q = qs({ ownerAsiakasId, language: language || undefined });
  const rows = await client.get<Row[]>(
    `/api/legal-documents/${encodeURIComponent(typeName)}/versions${q}`
  );
  let items = (Array.isArray(rows) ? rows : []).map(stripContent);
  // Client-side lifecycle filter — the backend returns the full history.
  if (status) items = items.filter((r) => r.status === status);
  return listEnvelope(items);
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
  return listEnvelope(items);
}

/**
 * Classify `legal get`'s positional (feedback #231): `ib legal list` keys its
 * rows by typeName, so `ib legal get PRIVACY` must work as the natural
 * follow-up. Digits-only → documentId (parseId's canonical-integer guard);
 * the server-side typeName grammar (`^[A-Z][A-Z0-9_]*$` in
 * puminet5api modules/legalDocument, matched case-insensitively here and
 * uppercased) → typeName. Anything else exits 4 naming both remedies.
 */
export function parseLegalGetRef(ref: string): number | string {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return parseId(trimmed, "documentId");
  const upper = trimmed.toUpperCase();
  if (/^[A-Z][A-Z0-9_]*$/.test(upper)) return upper;
  failWith(
    `invalid documentId or typeName: "${ref}" — pass a numeric documentId (see ib legal list) or a typeName like PRIVACY (see ib legal types)`,
    4
  );
}

/** A numeric ref reads that exact version; a typeName ref resolves to the
 * type's current ACTIVE document via /current/:typeName (feedback #231). */
export async function runLegalGet(client: ApiClient, ref: number | string): Promise<Row> {
  if (typeof ref === "number") return client.get<Row>(`/api/legal-documents/document/${ref}`);
  try {
    return await client.get<Row>(`/api/legal-documents/current/${encodeURIComponent(ref)}`);
  } catch (e) {
    if (e instanceof CliError && e.statusCode === 404) {
      throw new CliError(
        `no active document of type "${ref}"`,
        e.statusCode,
        null,
        5,
        `ib legal versions ${ref} lists drafts/history; ib legal types lists valid typeNames`
      );
    }
    throw e;
  }
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
      failWith(`Type "${input.type}" has no active version to diff against`, 5);
    }
    if (!draft) {
      failWith(`Type "${input.type}" has no draft version to diff`, 5);
    }
    // Independent fetches — issue them together (saves one full round-trip).
    [docA, docB] = await bothInOrder(
      runLegalGet(client, Number(active.documentId)),
      runLegalGet(client, Number(draft.documentId))
    );
  } else {
    [docA, docB] = await bothInOrder(
      runLegalGet(client, input.a),
      runLegalGet(client, input.b)
    );
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
    failWith(
      `Unknown document type "${typeName}". Valid: ${list.map((x) => x.typeName).join(", ")}`,
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
    language: fields.language,
  };
  return client.post<unknown>("/api/legal-documents/save", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Guard for edit-mode `legal save` (feedback from Task 9 review): the doc read
 * by `runLegalShow` may be Task 8's `fi` FALLBACK rather than the requested
 * language — `--append`/`--prepend` don't require matching existing text, so
 * that fallback would otherwise be edited and re-saved silently mislabelled.
 * `doc.language` is a real column on legalDocuments (Task 8), so the SERVED
 * language is always knowable from the response — compare it to what was
 * requested and refuse (exit 4) on a mismatch instead of trusting the request.
 *
 * A response with NO `language` field at all (an older backend, or a shape
 * change) is deliberately NOT treated as a mismatch: there is nothing to
 * verify against, so this is a no-op rather than a false refusal. That is a
 * DELIBERATE fail-open choice, not an oversight — the alternative (fail closed
 * whenever `language` is absent) would break edit mode entirely against any
 * backend that doesn't yet return the column, for a mismatch this guard cannot
 * even detect in that case.
 */
export function assertServedLanguageMatches(
  type: string,
  requested: string | undefined,
  doc: Row
): void {
  const want = requested ?? "fi";
  const served = doc.language;
  if (typeof served !== "string") return; // cannot verify — see doc comment above
  if (served === want) return;
  failWith(
    `no active ${want} document exists for ${type} — the edit would apply to the ${served} fallback and publish it mislabelled as ${want}. Create the ${want} version with a full --file/--content save first.`,
    4
  );
}

/**
 * Edit-mode `legal save`: in-field partial edit of the CURRENT ACTIVE document's
 * markdown, saved as a NEW immutable version (versions are never mutated in
 * place). Fetches the active doc (typeName implies the tenant), applies the edit
 * locally, then `--dry-run` returns the field diff WITHOUT writing (client-side,
 * safe-by-construction), or a real run delegates to `runLegalSave`. `--title`
 * defaults to the current doc's title when omitted. `fields.language` (when
 * given) selects WHICH language's current active document is read and tags the
 * saved edit with that same language — but Task 8's read endpoint deliberately
 * FALLS BACK to the `fi` row when no active `en` row exists for the type (so a
 * missing translation is never a blank consent gate). Trusting the request
 * alone would let an edit silently read Finnish content and publish it tagged
 * `language: en`; {@link assertServedLanguageMatches} refuses instead.
 */
export async function runLegalSaveWithEdit(
  client: ApiClient,
  type: string,
  op: TextEditOp,
  fields: {
    version: string;
    title?: string;
    ownerAsiakasId?: number;
    notes?: string;
    effectiveDate?: string;
    activate?: boolean;
    language?: string;
  },
  flags: WriteFlags
): Promise<unknown> {
  const current = await runLegalShow(client, type, false, fields.language); // /current/:type ; 404 → CliError exit 5
  assertServedLanguageMatches(type, fields.language, current);
  const before = typeof current.markdownContent === "string" ? current.markdownContent : "";
  const { next, matchCount } = applyTextEdit(before, op);
  if (flags.dryRun) {
    return textEditDryRunEnvelope(before, next, matchCount, { type }, "markdownContent");
  }
  const title = fields.title ?? (typeof current.title === "string" ? current.title : "");
  return runLegalSave(
    client,
    {
      typeName: type,
      version: fields.version,
      title,
      markdownContent: next,
      ownerAsiakasId: fields.ownerAsiakasId,
      notes: fields.notes,
      effectiveDate: fields.effectiveDate,
      activate: fields.activate,
      language: fields.language,
    },
    flags
  );
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
  const suffix = qs({ version: opts.version || undefined, limit: opts.limit ?? undefined });
  const data = await client.get<{
    typeName: string;
    personSettingTypeId: number;
    count: number;
    truncated: boolean;
    acceptances: Row[];
  }>(`/api/legal-documents/acceptances/${encodeURIComponent(typeName)}${suffix}`);
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
  // Both reads are keyed on typeName alone, so they go out together. A BAD
  // typeName fails both (404 here, "unknown document type" there), so the pair
  // is ordered — the document 404 stays the reported error, as when these awaits
  // were sequential. The doc GET 404 maps to exit 5 via CliError.
  const [doc, t] = await bothInOrder(
    client.get<Row>(`/api/legal-documents/current/${encodeURIComponent(typeName)}`),
    resolveDocumentType(client, typeName)
  );
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
    .action(jsonAction(getClient, runLegalTypes));

  legal
    .command("show <typeName>")
    .option("--meta")
    .option("--language <l>", LANGUAGE_FLAG_DESC, "fi")
    .action(
      jsonAction(getClient, (client, typeName: string, opts: { meta?: boolean; language?: string }) =>
        runLegalShow(client, typeName, !!opts.meta, normalizeLegalLanguage(opts.language))
      )
    );

  legal
    .command("active")
    .alias("list")
    .option("--language <l>", LANGUAGE_FLAG_DESC, "fi")
    .action(
      jsonAction(getClient, (client, opts: { language?: string }) =>
        runLegalActive(client, normalizeLegalLanguage(opts.language))
      )
    );

  legal
    .command("status")
    .option("--person <id>", "", Number)
    .option("--owner <id>", "", Number)
    .action(
      guarded(async (opts: { person?: number; owner?: number }) => {
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        const personId =
          opts.person ??
          claims.personId ??
          failWith("could not resolve personId from the active token — pass --person <id>", 4);
        const owner = opts.owner ?? claims.ownerAsiakasId ?? null;
        writeJson(await runLegalStatus(client, personId, owner));
      })
    );

  legal
    .command("versions <typeName>")
    .option("--owner <id>", "", Number)
    .option("--status <status>")
    .option("--language <l>", LANGUAGE_FLAG_DESC, "fi")
    .action(
      guarded(async (typeName: string, opts: { owner?: number; status?: string; language?: string }) => {
        if (opts.status && !LEGAL_STATUSES.includes(opts.status as (typeof LEGAL_STATUSES)[number])) {
          failWith(`Invalid --status "${opts.status}". Valid: ${LEGAL_STATUSES.join(", ")}`, 4);
        }
        const language = normalizeLegalLanguage(opts.language);
        const client = await getClient();
        writeJson(await runLegalVersions(client, typeName, opts.owner, opts.status, language));
      })
    );

  legal
    .command("drafts")
    .action(jsonAction(getClient, runLegalDrafts));

  legal
    .command("diff [a] [b]")
    .option("--type <typeName>")
    .option("--owner <id>", "", Number)
    .action(
      guarded(async (aStr: string | undefined, bStr: string | undefined, opts: { type?: string; owner?: number }) => {
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
      })
    );

  legal
    .command("get <documentIdOrType>")
    .action(
      guarded(async (refStr: string) => {
        const ref = parseLegalGetRef(refStr);
        const client = await getClient();
        writeJson(await runLegalGet(client, ref));
      })
    );

  const saveCmd = legal
    .command("save")
    .requiredOption("--type <typeName>")
    // NOT --version: the root global -V/--version is recognised anywhere in argv
    // and would shadow it (enforced by the root-option reuse test in
    // test/reference/help-wiring.test.ts).
    .requiredOption("--doc-version <v>")
    .option("--title <title>")
    .option("--file <path>")
    .option("--content <markdown>")
    .option("--owner <id>", "", Number)
    .option("--notes <text>")
    .option("--effective-date <date>")
    .option("--activate")
    .option("--validate-json")
    .option("--language <l>", LANGUAGE_FLAG_DESC, "fi");
  addEditFlags(saveCmd);
  addWriteFlagsToCommand(saveCmd).action(
    guarded(async (opts: WriteFlags & {
      type: string;
      docVersion: string;
      title?: string;
      file?: string;
      content?: string;
      owner?: number;
      notes?: string;
      effectiveDate?: string;
      activate?: boolean;
      validateJson?: boolean;
      language?: string;
      replace?: string;
      with?: string;
      append?: string;
      prepend?: string;
      all?: boolean;
    }) => {
      const language = normalizeLegalLanguage(opts.language);
      const editOp = parseEditOp(opts);
      if (editOp) {
        if (opts.file !== undefined || opts.content !== undefined) {
          failUsage("edit mode (--replace/--append/--prepend) is mutually exclusive with --file/--content");
        }
        const client = await getClient();
        writeJson(
          await runLegalSaveWithEdit(
            client,
            opts.type,
            editOp,
            {
              version: opts.docVersion,
              title: opts.title,
              ownerAsiakasId: opts.owner,
              notes: opts.notes,
              effectiveDate: opts.effectiveDate,
              activate: !!opts.activate,
              language,
            },
            opts
          )
        );
        return;
      }
      if (!opts.file && !opts.content) failWith("Provide --file <path> or --content <markdown>", 4);
      if (!opts.title) failWith("Missing required flag: --title", 4);
      if (opts.file && opts.content) failWith("--file and --content are mutually exclusive", 4);
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
      const client = await getClient();
      writeJson(
        await runLegalSave(
          client,
          {
            typeName: opts.type,
            version: opts.docVersion,
            title: opts.title!, // guarded above: failWith exits if undefined
            markdownContent,
            ownerAsiakasId: opts.owner,
            notes: opts.notes,
            effectiveDate: opts.effectiveDate,
            activate: !!opts.activate,
            language,
          },
          opts
        )
      );
    })
  );

  const activateCmd = legal
    .command("activate <documentId>");
  addWriteFlagsToCommand(activateCmd).action(
    guarded(async (documentIdStr: string, opts: WriteFlags) => {
      const documentId = parseId(documentIdStr, "documentId");
      const client = await getClient();
      writeJson(await runLegalActivate(client, documentId, opts));
    })
  );

  const deleteCmd = legal
    .command("delete <documentId>");
  addWriteFlagsToCommand(deleteCmd).action(
    guarded(async (documentIdStr: string, opts: WriteFlags) => {
      const documentId = parseId(documentIdStr, "documentId");
      const client = await getClient();
      writeJson(await runLegalDelete(client, documentId, opts));
    })
  );

  legal
    .command("acceptances <typeName>")
    // NOT --version: shadowed by the root global -V/--version (enforced by the
    // root-option reuse test in test/reference/help-wiring.test.ts).
    .option("--doc-version <v>")
    .option("--limit <n>", "", cappedInt(500))
    .action(
      jsonAction(getClient, (client, typeName: string, opts: { docVersion?: string; limit?: number }) =>
        runLegalAcceptances(client, typeName, {
          version: opts.docVersion,
          limit: opts.limit,
        })
      )
    );

  const acceptCmd = legal
    .command("accept [typeName]")
    .option("--type <typeName>");
  addWriteFlagsToCommand(acceptCmd).action(
    guarded(async (
      typeNameArg: string | undefined,
      opts: WriteFlags & { type?: string }
    ) => {
      const typeName = resolveTypeNameTarget(typeNameArg, opts.type);
      const client = await getClient();
      const claims = decodeJwtPayload(client.getCurrentToken());
      assertDeveloperClaims(claims);
      const personId =
        claims.personId ??
        failWith("could not resolve personId from the active token", 4);
      writeJson(await runLegalAccept(client, typeName, personId, opts));
    })
  );

  const typeGroup = legal
    .command("type")
    .description("Legal document TYPE management — create types, fix acceptance mappings (developer/sysadmin)");

  const typeCreateCmd = typeGroup
    .command("create")
    .requiredOption("--name <typeName>")
    .requiredOption("--display-name <s>")
    .option("--description <s>")
    .option("--sort-order <n>", "", Number)
    .option("--setting-type-id <n>", "", Number);
  addWriteFlagsToCommand(typeCreateCmd).action(
    guarded(async (opts: WriteFlags & {
      name: string;
      displayName: string;
      description?: string;
      sortOrder?: number;
      settingTypeId?: number;
    }) => {
      const client = await getClient();
      writeJson(await runLegalTypeCreate(client, opts.name, pickTypeFields(opts), opts));
    })
  );

  const typeUpdateCmd = typeGroup
    .command("update <typeName>")
    .option("--display-name <s>")
    .option("--description <s>")
    .option("--sort-order <n>", "", Number)
    .option("--setting-type-id <n>", "", Number);
  addWriteFlagsToCommand(typeUpdateCmd).action(
    guarded(async (
      typeName: string,
      opts: WriteFlags & {
        displayName?: string;
        description?: string;
        sortOrder?: number;
        settingTypeId?: number;
      }
    ) => {
      const client = await getClient();
      writeJson(await runLegalTypeUpdate(client, typeName, pickTypeFields(opts), opts));
    })
  );
}
