import { readFile } from "node:fs/promises";
import { CliError } from "../../api/errors.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
const stripContent = (d) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { markdownContent, ...rest } = d;
    return rest;
};
export async function runLegalTypes(client) {
    const rows = await client.get("/api/legal-documents/types");
    const items = Array.isArray(rows) ? rows : [];
    return { items, nextCursor: null, count: items.length };
}
export async function runLegalShow(client, typeName, metaOnly) {
    const doc = await client.get(`/api/legal-documents/current/${encodeURIComponent(typeName)}`);
    if (metaOnly && doc && typeof doc === "object") {
        const len = typeof doc.markdownContent === "string" ? doc.markdownContent.length : 0;
        return { ...stripContent(doc), contentLength: len };
    }
    return doc;
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
export async function runLegalVersions(client, typeName, ownerAsiakasId) {
    const q = ownerAsiakasId != null ? `?ownerAsiakasId=${ownerAsiakasId}` : "";
    const rows = await client.get(`/api/legal-documents/${encodeURIComponent(typeName)}/versions${q}`);
    const items = (Array.isArray(rows) ? rows : []).map(stripContent);
    return { items, nextCursor: null, count: items.length };
}
export async function runLegalGet(client, documentId) {
    return client.get(`/api/legal-documents/document/${documentId}`);
}
export async function resolveDocumentType(client, typeName) {
    const types = await client.get("/api/legal-documents/types");
    const list = Array.isArray(types) ? types : [];
    const t = list.find((x) => x.typeName === typeName);
    if (!t) {
        throw new CliError(`Unknown document type "${typeName}". Valid: ${list.map((x) => x.typeName).join(", ")}`, 404, null, 5);
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
    };
    return client.post("/api/legal-documents/save", body, {
        headers: writeFlagsToHeaders(flags),
    });
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
    const params = new URLSearchParams();
    if (opts.version)
        params.set("version", opts.version);
    if (opts.limit != null)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    const data = await client.get(`/api/legal-documents/acceptances/${encodeURIComponent(typeName)}${qs ? `?${qs}` : ""}`);
    const out = {
        items: data.acceptances ?? [],
        nextCursor: null,
        count: data.count ?? (data.acceptances ?? []).length,
        typeName: data.typeName,
        personSettingTypeId: data.personSettingTypeId,
    };
    if (data.truncated)
        out.truncated = true;
    return out;
}
/** Client-side dev-gate for `accept` — the endpoint itself stays user-open (FE flows). */
export function assertDeveloperClaims(claims) {
    if (!claims.isDeveloper && !claims.isSystemAdmin) {
        failWith("ib legal accept is a developer/sysadmin testing aid. Real consent is recorded via the betoni.online / betonijerry.fi UI.", 3);
    }
}
export async function runLegalAccept(client, typeName, personId, flags) {
    const doc = await client.get(`/api/legal-documents/current/${encodeURIComponent(typeName)}`); // 404 (no active doc) -> exit 5 via CliError
    const t = await resolveDocumentType(client, typeName);
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
        .description("List legal document types (GET /api/legal-documents/types)")
        .action(async () => {
        try {
            const client = await getClient();
            writeJson(await runLegalTypes(client));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    legal
        .command("show <typeName>")
        .description("Current ACTIVE document of a type, incl. markdown content")
        .option("--meta", "Omit markdownContent (returns contentLength instead)")
        .action(async (typeName, opts) => {
        try {
            const client = await getClient();
            writeJson(await runLegalShow(client, typeName, !!opts.meta));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    legal
        .command("status")
        .description("Which legal documents you have accepted / still need to accept")
        .option("--person <id>", "Check another person (developer/sysadmin only)", Number)
        .option("--owner <id>", "ownerAsiakasId scope (default: your company from the token)", Number)
        .action(async (opts) => {
        try {
            const client = await getClient();
            const claims = decodeJwtPayload(client.getCurrentToken());
            const personId = opts.person ?? claims.personId;
            const owner = opts.owner ?? claims.ownerAsiakasId ?? null;
            writeJson(await runLegalStatus(client, personId, owner));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    legal
        .command("versions <typeName>")
        .description("All versions of a document type (active + drafts + history)")
        .option("--owner <id>", "Filter by ownerAsiakasId tenant scope", Number)
        .action(async (typeName, opts) => {
        try {
            const client = await getClient();
            writeJson(await runLegalVersions(client, typeName, opts.owner));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    legal
        .command("get <documentId>")
        .description("One document version by id, incl. markdown content")
        .action(async (documentIdStr) => {
        const documentId = Number(documentIdStr);
        if (!Number.isInteger(documentId) || documentId <= 0) {
            failWith(`Invalid documentId "${documentIdStr}"`, 4);
        }
        try {
            const client = await getClient();
            writeJson(await runLegalGet(client, documentId));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const saveCmd = legal
        .command("save")
        .description("Create a NEW document version (immutable; draft unless --activate)")
        .requiredOption("--type <typeName>", "Document type name (see ib legal types)")
        .requiredOption("--version <v>", "Version string, e.g. 2.0")
        .requiredOption("--title <title>", "Document title")
        .option("--file <path>", "Read markdown content from a local file")
        .option("--content <markdown>", "Inline markdown content (use over /api/cli/exec — no local FS there)")
        .option("--owner <id>", "ownerAsiakasId tenant scope (e.g. 1349 = BetoniJerry); omit for global", Number)
        .option("--notes <text>", "Internal notes")
        .option("--effective-date <date>", "Effective date YYYY-MM-DD (default: now)")
        .option("--activate", "Publish immediately (deactivates prior versions). Default: inactive draft");
    addWriteFlagsToCommand(saveCmd).action(async (opts) => {
        if (!opts.file && !opts.content)
            failWith("Provide --file <path> or --content <markdown>", 4);
        if (opts.file && opts.content)
            failWith("--file and --content are mutually exclusive", 4);
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        let markdownContent = opts.content ?? "";
        if (opts.file) {
            try {
                markdownContent = await readFile(opts.file, "utf8");
            }
            catch {
                failWith(`Cannot read file: ${opts.file}`, 4);
            }
        }
        try {
            const client = await getClient();
            writeJson(await runLegalSave(client, {
                typeName: opts.type,
                version: opts.version,
                title: opts.title,
                markdownContent,
                ownerAsiakasId: opts.owner,
                notes: opts.notes,
                effectiveDate: opts.effectiveDate,
                activate: !!opts.activate,
            }, { dryRun: opts.dryRun, reason: opts.reason, idempotencyKey: opts.idempotencyKey }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const activateCmd = legal
        .command("activate <documentId>")
        .description("Publish a version: atomically deactivates siblings, activates this one");
    addWriteFlagsToCommand(activateCmd).action(async (documentIdStr, opts) => {
        const documentId = Number(documentIdStr);
        if (!Number.isInteger(documentId) || documentId <= 0) {
            failWith(`Invalid documentId "${documentIdStr}"`, 4);
        }
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        try {
            const client = await getClient();
            writeJson(await runLegalActivate(client, documentId, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const deleteCmd = legal
        .command("delete <documentId>")
        .description("Soft-delete (deactivate) a document version");
    addWriteFlagsToCommand(deleteCmd).action(async (documentIdStr, opts) => {
        const documentId = Number(documentIdStr);
        if (!Number.isInteger(documentId) || documentId <= 0) {
            failWith(`Invalid documentId "${documentIdStr}"`, 4);
        }
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        try {
            const client = await getClient();
            writeJson(await runLegalDelete(client, documentId, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    legal
        .command("acceptances <typeName>")
        .description("Compliance report: WHO has accepted a document type (developer/sysadmin)")
        .option("--version <v>", "Only acceptances of this version string")
        .option("--limit <n>", "Max rows (default 500, cap 500)", (v) => Math.min(Number(v), 500))
        .action(async (typeName, opts) => {
        try {
            const client = await getClient();
            writeJson(await runLegalAcceptances(client, typeName, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const acceptCmd = legal
        .command("accept")
        .description("Record YOUR OWN acceptance of the current active version (developer testing aid)")
        .requiredOption("--type <typeName>", "Document type name to accept");
    addWriteFlagsToCommand(acceptCmd).action(async (opts) => {
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        try {
            const client = await getClient();
            const claims = decodeJwtPayload(client.getCurrentToken());
            assertDeveloperClaims(claims);
            writeJson(await runLegalAccept(client, opts.type, claims.personId, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map