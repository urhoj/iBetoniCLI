import { readFile } from "node:fs/promises";
import { CliError } from "../../api/errors.js";
import { listEnvelope } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson, failWith, failUsage, warnNote } from "../../output/json.js";
import { personIdFromClaims } from "../../owner.js";
import { parseId, cappedInt, assertEnum, intFlag } from "../../targets.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { lineDiff } from "../../textDiff.js";
import { addEditFlags, applyTextEdit, parseEditOp, textEditDryRunEnvelope } from "../../textEdit.js";
import { validateStructuredJson } from "./validateJson.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
import { bothInOrder } from "../../parallel.js";
/** Lifecycle status values on legalDocuments.status (see backend migration). */
export const LEGAL_STATUSES = ["draft", "active", "archived", "deleted"];
/**
 * Document language values on legalDocuments.language (Task 8 backend). `fi`
 * is the binding original; `en` is an unofficial translation — the backend
 * falls back to the `fi` row when no active `en` row exists for a type.
 */
export const LEGAL_LANGUAGES = ["fi", "en"];
/** Normalize --language to a validated lowercase fi|en, defaulting to fi (the binding original) when omitted. Exits 4 on a bad code. */
export function normalizeLegalLanguage(lang) {
    const v = (lang ?? "fi").trim().toLowerCase();
    assertEnum(v, LEGAL_LANGUAGES, "--language");
    return v;
}
const LANGUAGE_FLAG_DESC = "Document language: fi (binding) or en (unofficial translation). Default fi.";
const stripContent = (d) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { markdownContent, ...rest } = d;
    return rest;
};
/** markdownContent length (0 when absent) — shared by the *-meta projections. */
const contentLengthOf = (d) => typeof d.markdownContent === "string" ? d.markdownContent.length : 0;
/** Strip content but report its length — the per-side meta used by `ib legal diff`. */
const diffMeta = (d) => ({ ...stripContent(d), contentLength: contentLengthOf(d) });
export async function runLegalTypes(client) {
    const rows = await client.get("/api/legal-documents/types");
    const items = Array.isArray(rows) ? rows : [];
    return listEnvelope(items);
}
export async function runLegalShow(client, typeName, metaOnly, language) {
    const suffix = qs({ language: language || undefined });
    const doc = await client.get(`/api/legal-documents/current/${encodeURIComponent(typeName)}${suffix}`);
    if (metaOnly && doc && typeof doc === "object")
        return diffMeta(doc);
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
export async function runLegalActive(client, language) {
    const types = await runLegalTypes(client);
    const items = await Promise.all(types.items.map(async (t) => {
        const base = {
            typeName: t.typeName,
            displayName: t.displayName ?? null,
            personSettingTypeId: t.personSettingTypeId,
        };
        try {
            const doc = await runLegalShow(client, t.typeName, false, language);
            return {
                ...base,
                hasActive: true,
                documentId: doc.documentId ?? null,
                version: doc.version ?? null,
                title: doc.title ?? null,
                effectiveDate: doc.effectiveDate ?? null,
                contentLength: contentLengthOf(doc),
            };
        }
        catch (e) {
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
    }));
    return listEnvelope(items);
}
export async function runLegalStatus(client, personId, ownerAsiakasId) {
    const q = ownerAsiakasId != null ? `?ownerAsiakasId=${ownerAsiakasId}` : "";
    const data = await client.get(`/api/legal-documents/check-acceptances/${personId}${q}`);
    // markdownContent on missing docs can exceed 10 KB each — `ib legal show` reads content.
    return {
        personId,
        ownerAsiakasId,
        requiresAcceptance: data.requiresAcceptance === true,
        accepted: (data.acceptedAcceptances ?? []).map(stripContent),
        missing: (data.missingAcceptances ?? []).map(stripContent),
    };
}
/**
 * All versions of one document type, newest first.
 *
 * Options object rather than positionals: this grew to five parameters, four of
 * them optional, so call sites read as `(c, "TOS", undefined, undefined, true)`
 * with nothing naming the flag. It also rejoins the convention its siblings
 * already follow (`runFeedbackList`, `runFeedbackCount`, `runCacheKeys`, …).
 */
export async function runLegalVersions(client, typeName, opts = {}) {
    const { ownerAsiakasId, status, language, includeDeleted } = opts;
    const q = qs({ ownerAsiakasId, language: language || undefined });
    const rows = await client.get(`/api/legal-documents/${encodeURIComponent(typeName)}/versions${q}`);
    let items = (Array.isArray(rows) ? rows : []).map(stripContent);
    // Client-side lifecycle filter — the backend returns the full history. An
    // explicit --status is the caller naming exactly what they want and wins
    // outright (so `--status deleted` still selects them); otherwise soft-deleted
    // rows are hidden by DEFAULT (fb#514). `ib legal delete` keeps the row for
    // audit, which is right, but every throwaway verification draft then stayed
    // visible forever on a COMPLIANCE-relevant listing — BETONIJERRY_TOS was 8
    // rows, 3 of them dead `zz-*` probes, and reading it correctly required knowing
    // that convention. `ib vehicle list` is the precedent: excluded by default,
    // revealed with --deleted.
    if (status)
        items = items.filter((r) => r.status === status);
    else if (!includeDeleted)
        items = items.filter((r) => r.status !== "deleted");
    return listEnvelope(items);
}
/**
 * Unpublished DRAFT versions across EVERY type — the cross-type answer to "is
 * anything staged to publish?". `active` rolls up live docs; this rolls up
 * drafts. Client-side fan-out over `types` + `versions` (the per-type cached
 * read), filtered to status='draft'. Content is stripped (read a body via
 * `ib legal get <documentId>` or compare with `ib legal diff`).
 */
export async function runLegalDrafts(client) {
    const types = await runLegalTypes(client);
    const perType = await Promise.all(types.items.map((t) => runLegalVersions(client, t.typeName, { status: "draft" }).then((v) => v.items)));
    const items = perType.flat();
    return listEnvelope(items);
}
/**
 * Classify `legal get`'s target — the value resolved from its positional OR
 * `--type` (feedback #231, fb#1036). Because both spellings land here, a
 * digits-only `--type` is still read as a documentId: `ib legal get --type 12`
 * succeeds and returns document 12, even though the flag is described as the
 * typeName form. Harmless (identical to the positional result) and documented
 * rather than rejected, so the alias stays a pure spelling choice.
 * `ib legal list` keys its
 * rows by typeName, so `ib legal get PRIVACY` must work as the natural
 * follow-up. Digits-only → documentId (parseId's canonical-integer guard);
 * the server-side typeName grammar (`^[A-Z][A-Z0-9_]*$` in
 * puminet5api modules/legalDocument, matched case-insensitively here and
 * uppercased) → typeName. Anything else exits 4 naming both remedies.
 */
export function parseLegalGetRef(ref) {
    const trimmed = ref.trim();
    if (/^\d+$/.test(trimmed))
        return parseId(trimmed, "documentId");
    const upper = trimmed.toUpperCase();
    if (/^[A-Z][A-Z0-9_]*$/.test(upper))
        return upper;
    failWith(`invalid documentId or typeName: "${ref}" — pass a numeric documentId (see ib legal list) or a typeName like PRIVACY (see ib legal types)`, 4);
}
/** A numeric ref reads that exact version; a typeName ref resolves to the
 * type's current ACTIVE document via /current/:typeName (feedback #231). */
export async function runLegalGet(client, ref) {
    if (typeof ref === "number")
        return client.get(`/api/legal-documents/document/${ref}`);
    try {
        return await client.get(`/api/legal-documents/current/${encodeURIComponent(ref)}`);
    }
    catch (e) {
        if (e instanceof CliError && e.statusCode === 404) {
            throw new CliError(`no active document of type "${ref}"`, e.statusCode, null, 5, `ib legal versions ${ref} lists drafts/history; ib legal types lists valid typeNames`);
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
export async function runLegalDiff(client, input) {
    let docA;
    let docB;
    if ("type" in input) {
        const versions = await runLegalVersions(client, input.type, { ownerAsiakasId: input.owner });
        const active = versions.items.find((r) => r.status === "active");
        const draft = versions.items.find((r) => r.status === "draft"); // newest first (createdTime DESC)
        if (!active) {
            failWith(`Type "${input.type}" has no active version to diff against`, 5);
        }
        if (!draft) {
            failWith(`Type "${input.type}" has no draft version to diff`, 5);
        }
        // Independent fetches — issue them together (saves one full round-trip).
        [docA, docB] = await bothInOrder(runLegalGet(client, Number(active.documentId)), runLegalGet(client, Number(draft.documentId)));
    }
    else {
        [docA, docB] = await bothInOrder(runLegalGet(client, input.a), runLegalGet(client, input.b));
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
export async function resolveDocumentType(client, typeName) {
    const list = (await runLegalTypes(client)).items;
    const t = list.find((x) => x.typeName === typeName);
    if (!t) {
        failWith(`Unknown document type "${typeName}". Valid: ${list.map((x) => x.typeName).join(", ")}`, 5);
    }
    return t;
}
export async function runLegalSave(client, fields, flags) {
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
    return client.post("/api/legal-documents/save", body, {
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
export function assertServedLanguageMatches(type, requested, doc) {
    const want = requested ?? "fi";
    const served = doc.language;
    if (typeof served !== "string")
        return; // cannot verify — see doc comment above
    if (served === want)
        return;
    failWith(`no active ${want} document exists for ${type} — the edit would apply to the ${served} fallback and publish it mislabelled as ${want}. Create the ${want} version with a full --file/--content save first.`, 4);
}
/**
 * DB column legalDocuments.version is nvarchar(20); an overlong --doc-version
 * used to surface as an opaque backend 500 DATABASE_ERROR that reproduced on
 * every slot and read as a server-side outage (feedback #444). The width is a
 * fixed schema fact, so refuse client-side (exit 4) before any request.
 */
export const DOC_VERSION_MAX_LENGTH = 20;
export function assertDocVersionLength(docVersion) {
    if (docVersion.length > DOC_VERSION_MAX_LENGTH) {
        failWith(`--doc-version is limited to ${DOC_VERSION_MAX_LENGTH} characters (legalDocuments.version nvarchar(${DOC_VERSION_MAX_LENGTH})); got ${docVersion.length}`, 4);
    }
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
export async function runLegalSaveWithEdit(client, type, op, fields, flags) {
    const current = await runLegalShow(client, type, false, fields.language); // /current/:type ; 404 → CliError exit 5
    assertServedLanguageMatches(type, fields.language, current);
    const before = typeof current.markdownContent === "string" ? current.markdownContent : "";
    const { next, matchCount, seamInserted } = applyTextEdit(before, op);
    if (seamInserted)
        warnNote("[ib] a newline seam was inserted between the existing text and the new text (fb#790)");
    if (flags.dryRun) {
        return textEditDryRunEnvelope(before, next, matchCount, { type }, "markdownContent", seamInserted);
    }
    const title = fields.title ?? (typeof current.title === "string" ? current.title : "");
    return runLegalSave(client, {
        typeName: type,
        version: fields.version,
        title,
        markdownContent: next,
        ownerAsiakasId: fields.ownerAsiakasId,
        notes: fields.notes,
        effectiveDate: fields.effectiveDate,
        activate: fields.activate,
        language: fields.language,
    }, flags);
}
export async function runLegalActivate(client, documentId, flags) {
    return client.put(`/api/legal-documents/activate/${documentId}`, {}, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runLegalDelete(client, documentId, flags) {
    return client.delete(`/api/legal-documents/${documentId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runLegalAcceptances(client, typeName, opts) {
    const suffix = qs({ version: opts.version || undefined, limit: opts.limit ?? undefined });
    const data = await client.get(`/api/legal-documents/acceptances/${encodeURIComponent(typeName)}${suffix}`);
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
/** Map CLI flags → API body fields; only flags the user actually passed. */
export function pickTypeFields(opts) {
    const fields = {};
    if (opts.displayName !== undefined)
        fields.displayName = opts.displayName;
    if (opts.description !== undefined)
        fields.description = opts.description;
    if (opts.sortOrder !== undefined)
        fields.sortOrder = opts.sortOrder;
    if (opts.settingTypeId !== undefined)
        fields.personSettingTypeId = opts.settingTypeId;
    return fields;
}
export async function runLegalTypeCreate(client, typeName, fields, flags) {
    return client.post("/api/legal-documents/types", { typeName, ...fields }, { headers: writeFlagsToHeaders(flags) });
}
export async function runLegalTypeUpdate(client, typeName, fields, flags) {
    if (Object.keys(fields).length === 0) {
        throw new CliError("nothing to update: pass at least one of --display-name / --description / --sort-order / --setting-type-id", 0, null, 4);
    }
    return client.put(`/api/legal-documents/types/${encodeURIComponent(typeName)}`, fields, { headers: writeFlagsToHeaders(flags) });
}
/**
 * The six positional-taking commands in this group — show, versions, get,
 * acceptances, accept and type update — name their document type POSITIONALLY,
 * with `--type` accepted as an alias (feedback #32, widened in fb#1036). Exactly
 * one is required; both are allowed only when they agree. `save` is flag-only
 * (`--type`, required), `diff` offers no positional type at all (its `[a] [b]`
 * are documentIds; `--type` is its optional mode selector) and `type create`
 * uses `--name`; none of the three reaches this helper.
 *
 * The alias exists because `save` REQUIRES the flag spelling and `diff` has only
 * that spelling for a type, so the group teaches `--type` first and callers then
 * reach for it on the read commands — two independent actors did so six times
 * in one session (fb#1036). Positional
 * stays canonical (it is what --help advertises); the flag is additive, so no
 * scripted invocation changes meaning.
 *
 * `label` names the positional in the error text: `get` takes <documentIdOrType>,
 * everything else <typeName>.
 */
export function resolveTypeNameTarget(positional, flag, label = "typeName") {
    const name = positional ?? flag;
    if (!name) {
        failWith(`missing document type: pass <${label}> positionally or via --type <typeName>`, 4);
    }
    if (positional !== undefined && flag !== undefined && positional !== flag) {
        failWith(`positional ${label} (${positional}) and --type (${flag}) differ — pass only one`, 4);
    }
    return name;
}
/** Client-side dev-gate for `accept` — the endpoint itself stays user-open (FE flows). */
export function assertDeveloperClaims(claims) {
    if (!claims.isDeveloper && !claims.isSystemAdmin) {
        failWith("ib legal accept is a developer/sysadmin testing aid. Real consent is recorded via the betoni.online / betonijerry.fi UI.", 3);
    }
}
export async function runLegalAccept(client, typeName, personId, flags) {
    // Both reads are keyed on typeName alone, so they go out together. A BAD
    // typeName fails both (404 here, "unknown document type" there), so the pair
    // is ordered — the document 404 stays the reported error, as when these awaits
    // were sequential. The doc GET 404 maps to exit 5 via CliError.
    const [doc, t] = await bothInOrder(client.get(`/api/legal-documents/current/${encodeURIComponent(typeName)}`), resolveDocumentType(client, typeName));
    if (!t.personSettingTypeId) {
        failWith(`Type ${typeName} has no personSettingTypeId mapping — acceptance cannot be tracked`, 4);
    }
    const body = {
        personId,
        documentId: doc.documentId,
        settingTypeId: t.personSettingTypeId,
        version: doc.version,
    };
    return client.post("/api/legal-documents/record-acceptance", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
export function registerLegalCommands(parent, getClient) {
    const legal = parent
        .command("legal")
        .description("Legal documents — what you have agreed to + developer document management");
    legal
        .command("types")
        .action(jsonAction(getClient, runLegalTypes));
    legal
        .command("show [typeName]")
        .option("--type <typeName>")
        .option("--meta")
        .option("--language <l>", LANGUAGE_FLAG_DESC, "fi")
        .action(jsonAction(getClient, (client, typeNameArg, opts) => runLegalShow(client, resolveTypeNameTarget(typeNameArg, opts.type), !!opts.meta, normalizeLegalLanguage(opts.language))));
    legal
        .command("active")
        .alias("list")
        .option("--language <l>", LANGUAGE_FLAG_DESC, "fi")
        .action(jsonAction(getClient, (client, opts) => runLegalActive(client, normalizeLegalLanguage(opts.language))));
    legal
        .command("status")
        .option("--person <id>", "", intFlag("--person", 1))
        .option("--owner <id>", "", intFlag("--owner", 1))
        .action(guarded(async (opts) => {
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        const personId = opts.person ?? personIdFromClaims(claims, "pass --person <id>");
        const owner = opts.owner ?? claims.ownerAsiakasId ?? null;
        writeJson(await runLegalStatus(client, personId, owner));
    }));
    legal
        .command("versions [typeName]")
        .option("--type <typeName>")
        .option("--owner <id>", "", intFlag("--owner", 1))
        .option("--status <status>")
        .option("--deleted")
        .option("--language <l>", LANGUAGE_FLAG_DESC, "fi")
        .action(guarded(async (typeNameArg, opts) => {
        const typeName = resolveTypeNameTarget(typeNameArg, opts.type);
        if (opts.status && !LEGAL_STATUSES.includes(opts.status)) {
            failWith(`Invalid --status "${opts.status}". Valid: ${LEGAL_STATUSES.join(", ")}`, 4);
        }
        const language = normalizeLegalLanguage(opts.language);
        const client = await getClient();
        writeJson(await runLegalVersions(client, typeName, {
            ownerAsiakasId: opts.owner,
            status: opts.status,
            language,
            includeDeleted: opts.deleted,
        }));
    }));
    legal
        .command("drafts")
        .action(jsonAction(getClient, runLegalDrafts));
    legal
        .command("diff [a] [b]")
        .option("--type <typeName>")
        .option("--owner <id>", "", intFlag("--owner", 1))
        .action(guarded(async (aStr, bStr, opts) => {
        let input;
        if (opts.type) {
            if (aStr !== undefined || bStr !== undefined) {
                failWith("pass either <a> <b> documentIds OR --type <name>, not both", 4);
            }
            input = { type: opts.type, owner: opts.owner };
        }
        else {
            if (opts.owner !== undefined)
                failWith("--owner only applies with --type", 4);
            if (aStr === undefined || bStr === undefined) {
                failWith("provide two positive documentIds (<a> <b>) or use --type <name>", 4);
            }
            const a = parseId(aStr, "version");
            const b = parseId(bStr, "version");
            input = { a, b };
        }
        const client = await getClient();
        writeJson(await runLegalDiff(client, input));
    }));
    // NO `show` alias here (unlike the other get leaves, fb#836): the legal group
    // ALREADY owns a real `show <typeName>` command — Commander refuses the alias,
    // and the show reflex already lands on a working (type-shaped) read.
    legal
        .command("get [documentIdOrType]")
        .option("--type <typeName>")
        .action(guarded(async (refArg, opts) => {
        const ref = parseLegalGetRef(resolveTypeNameTarget(refArg, opts.type, "documentIdOrType"));
        const client = await getClient();
        writeJson(await runLegalGet(client, ref));
    }));
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
        .option("--owner <id>", "", intFlag("--owner", 1))
        .option("--notes <text>")
        .option("--effective-date <date>")
        .option("--activate")
        .option("--validate-json")
        .option("--language <l>", LANGUAGE_FLAG_DESC, "fi");
    addEditFlags(saveCmd);
    addWriteFlagsToCommand(saveCmd).action(guarded(async (opts) => {
        assertDocVersionLength(opts.docVersion);
        const language = normalizeLegalLanguage(opts.language);
        const editOp = parseEditOp(opts);
        if (editOp) {
            if (opts.file !== undefined || opts.content !== undefined) {
                failUsage("edit mode (--replace/--append/--prepend) is mutually exclusive with --file/--content");
            }
            const client = await getClient();
            writeJson(await runLegalSaveWithEdit(client, opts.type, editOp, {
                version: opts.docVersion,
                title: opts.title,
                ownerAsiakasId: opts.owner,
                notes: opts.notes,
                effectiveDate: opts.effectiveDate,
                activate: !!opts.activate,
                language,
            }, opts));
            return;
        }
        if (!opts.file && !opts.content)
            failWith("Provide --file <path> or --content <markdown>", 4);
        if (!opts.title)
            failWith("Missing required flag: --title", 4);
        if (opts.file && opts.content)
            failWith("--file and --content are mutually exclusive", 4);
        let markdownContent = opts.content ?? "";
        if (opts.file) {
            try {
                markdownContent = await readFile(opts.file, "utf8");
            }
            catch {
                failWith(`Cannot read file: ${opts.file}`, 4);
            }
        }
        if (opts.validateJson) {
            const v = validateStructuredJson(markdownContent);
            if (!v.ok)
                failWith(`--validate-json failed: ${v.error}`, 4);
        }
        const client = await getClient();
        writeJson(await runLegalSave(client, {
            typeName: opts.type,
            version: opts.docVersion,
            title: opts.title, // guarded above: failWith exits if undefined
            markdownContent,
            ownerAsiakasId: opts.owner,
            notes: opts.notes,
            effectiveDate: opts.effectiveDate,
            activate: !!opts.activate,
            language,
        }, opts));
    }));
    // activate/delete share the whole registration: one <documentId> + write
    // flags. The id parses BEFORE getClient() so a bad id stays exit 4 even when
    // logged out.
    for (const [name, run] of [
        ["activate", runLegalActivate],
        ["delete", runLegalDelete],
    ]) {
        addWriteFlagsToCommand(legal.command(`${name} <documentId>`)).action(guarded(async (documentIdStr, opts) => {
            const documentId = parseId(documentIdStr, "documentId");
            const client = await getClient();
            writeJson(await run(client, documentId, opts));
        }));
    }
    legal
        .command("acceptances [typeName]")
        .option("--type <typeName>")
        // NOT --version: shadowed by the root global -V/--version (enforced by the
        // root-option reuse test in test/reference/help-wiring.test.ts).
        .option("--doc-version <v>")
        .option("--limit <n>", "", cappedInt(500))
        .action(jsonAction(getClient, (client, typeNameArg, opts) => runLegalAcceptances(client, resolveTypeNameTarget(typeNameArg, opts.type), {
        version: opts.docVersion,
        limit: opts.limit,
    })));
    const acceptCmd = legal
        .command("accept [typeName]")
        .option("--type <typeName>");
    addWriteFlagsToCommand(acceptCmd).action(guarded(async (typeNameArg, opts) => {
        const typeName = resolveTypeNameTarget(typeNameArg, opts.type);
        const client = await getClient();
        const claims = decodeJwtPayload(client.getCurrentToken());
        assertDeveloperClaims(claims);
        const personId = personIdFromClaims(claims);
        writeJson(await runLegalAccept(client, typeName, personId, opts));
    }));
    const typeGroup = legal
        .command("type")
        .description("Legal document TYPE management — create types, fix acceptance mappings (developer/sysadmin)");
    const typeCreateCmd = typeGroup
        .command("create")
        .requiredOption("--name <typeName>")
        .requiredOption("--display-name <s>")
        .option("--description <s>")
        .option("--sort-order <n>", "", intFlag("--sort-order", 0))
        .option("--setting-type-id <n>", "", intFlag("--setting-type-id", 1));
    addWriteFlagsToCommand(typeCreateCmd).action(guarded(async (opts) => {
        const client = await getClient();
        writeJson(await runLegalTypeCreate(client, opts.name, pickTypeFields(opts), opts));
    }));
    const typeUpdateCmd = typeGroup
        .command("update [typeName]")
        .option("--type <typeName>")
        .option("--display-name <s>")
        .option("--description <s>")
        .option("--sort-order <n>", "", intFlag("--sort-order", 0))
        .option("--setting-type-id <n>", "", intFlag("--setting-type-id", 1));
    addWriteFlagsToCommand(typeUpdateCmd).action(guarded(async (typeNameArg, opts) => {
        const typeName = resolveTypeNameTarget(typeNameArg, opts.type);
        const client = await getClient();
        writeJson(await runLegalTypeUpdate(client, typeName, pickTypeFields(opts), opts));
    }));
}
//# sourceMappingURL=index.js.map