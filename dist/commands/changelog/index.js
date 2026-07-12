import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { readFileSync } from "node:fs";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
export function readJsonInput(path) {
    const raw = (path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(raw);
}
const TYPES = ["feature", "improvement", "bugfix"];
const AREAS = ["frontend", "backend", "cli", "database", "cicd"];
const BUMP_LEVELS = ["none", "patch", "minor", "major"];
const LANGUAGES = ["fi", "en"]; // devChangelog.language is CHAR(2) NOT NULL DEFAULT 'fi'
const SOURCES = ["human", "routine"];
/**
 * The repos whose versions `npm run deploy` Step 0 bumps independently, each
 * from the max --bump-level across the unreleased entries that name it. A
 * --repo value NOT in this set is unknown to Step 0 and triggers a fail-safe
 * bump of EVERY coordinated repo (unless --bump-level none). The standalone
 * lane (betonicli, @ibetoni/*) versions separately via `npm run final`, so
 * target those with `--repo <name> --bump-level none`.
 */
const COORDINATED_REPOS = [
    "puminet4",
    "puminet5api",
    "puminet7-functions-app",
    "betonijerry",
    "workspace",
];
const REPO_FLAG_DESC = "Repo this entry ships in — coordinated: puminet4|puminet5api|puminet7-functions-app|betonijerry|workspace. ⚠ An unrecognized value fail-safe-bumps ALL coordinated repos on next deploy; for the standalone lane (betonicli, @ibetoni/*) also pass --bump-level none.";
/**
 * Normalize a Sentry issue reference: accept a bare short id (e.g. PUMINET5API-1A2)
 * or extract one from a pasted URL/string; otherwise trim and cap at 64 chars to fit
 * the devChangelog.sentryIssue column. Store-only — never sent to Sentry.
 */
export function normalizeSentryRef(raw) {
    const trimmed = raw.trim();
    const m = trimmed.match(/[A-Z0-9]{2,}-[A-Z0-9]+/);
    return (m ? m[0] : trimmed).slice(0, 64);
}
/**
 * POST /api/changelog. --dry-run is SERVER-side: the request carries X-Dry-Run
 * and the backend validates the payload (bad enum/date/missing fields still 400)
 * then echoes `{ dryRun, wouldCreate, validation }` without inserting.
 */
export async function runChangelogAdd(client, body, flags) {
    return client.post("/api/changelog", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runChangelogList(client, opts) {
    if (typeof opts.sentry === "string")
        opts.sentry = normalizeSentryRef(opts.sentry);
    const p = new URLSearchParams();
    // CLI option key → API query key. --feedback maps to the backend's `feedbackId`
    // filter; --search/--status are substring LIKE filters (the controller passes
    // req.query straight to listEntries). --has-feedback/--has-sentry are handled below.
    const keyMap = {
        month: "month", type: "type", area: "area", repo: "repo", feedback: "feedbackId",
        sentry: "sentryIssue", source: "source", search: "search", status: "status", limit: "limit",
    };
    for (const [optKey, apiKey] of Object.entries(keyMap)) {
        if (opts[optKey] !== undefined)
            p.set(apiKey, String(opts[optKey]));
    }
    if (opts.hasFeedback)
        p.set("hasFeedback", "1");
    if (opts.hasSentry)
        p.set("hasSentry", "1");
    const qs = p.toString();
    const rows = await client.get(`/api/changelog${qs ? `?${qs}` : ""}`);
    const items = Array.isArray(rows) ? rows : [];
    return { items, nextCursor: null, count: items.length };
}
export async function runChangelogGet(client, id) {
    return client.get(`/api/changelog/${id}`);
}
export async function runChangelogUpdate(client, id, patch, flags) {
    if (flags.dryRun)
        return { dryRun: true, wouldUpdate: { id, patch } };
    return client.put(`/api/changelog/${id}`, patch, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runChangelogReport(client, month, format) {
    return client.get(`/api/changelog/report?month=${month}&format=${format}`);
}
export async function runChangelogPending(client) {
    return client.get("/api/changelog/pending");
}
export async function runChangelogRelease(client, versionTag, flags) {
    return client.post("/api/changelog/release", { versionTag }, { headers: writeFlagsToHeaders(flags) });
}
export async function runChangelogReleaseMap(client, map, flags) {
    return client.post("/api/changelog/release", { map }, { headers: writeFlagsToHeaders(flags) });
}
export function validateEnums(type, area, bumpLevel, source) {
    if (type !== undefined && !TYPES.includes(type))
        failWith(`--type must be ${TYPES.join("|")}`, 4);
    if (area !== undefined && !AREAS.includes(area))
        failWith(`--area must be ${AREAS.join("|")}`, 4);
    if (bumpLevel !== undefined && !BUMP_LEVELS.includes(bumpLevel))
        failWith(`--bump-level must be ${BUMP_LEVELS.join("|")}`, 4);
    if (source !== undefined && !SOURCES.includes(source))
        failWith(`--source must be ${SOURCES.join("|")}`, 4);
}
/**
 * Resolve the entry description from the positional OR the --description alias
 * (mirrors `ib dev feedback create` — feedback #172). Exactly one is required;
 * both are allowed only when they agree. Exits 4 on conflict or absence.
 */
export function resolveChangelogDescription(positional, flag) {
    const p = positional?.trim();
    const f = flag?.trim();
    if (p && f && p !== f)
        failWith("Provide the description either positionally or with --description; if both are given, they must match", 4);
    const description = p || f;
    if (!description)
        failWith("--description (or a positional description) is required", 4);
    return description;
}
/** Normalize --language to a validated lowercase fi|en, or undefined when not passed. Exits 4 on a bad code. */
export function normalizeLanguage(lang) {
    if (lang === undefined)
        return undefined;
    const v = lang.trim().toLowerCase();
    if (!LANGUAGES.includes(v))
        failWith(`--language must be ${LANGUAGES.join("|")}`, 4);
    return v;
}
export function registerChangelogCommands(parent, getClient, opts = {}) {
    const c = parent
        .command("changelog", { hidden: !!opts.hidden })
        .description("Development changelog entries (source of the monthly report)");
    addWriteFlagsToCommand(c
        .command("add [description]")
        .description("Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row.")
        .requiredOption("--type <t>", "feature|improvement|bugfix")
        .requiredOption("--area <a>", "frontend|backend|cli|database|cicd")
        .requiredOption("--title <s>", "Entry title")
        .option("--description <s>", "Kuvaus — alias for the positional; if both are given, they must match")
        .option("--benefits <s>", "Hyödyt")
        .option("--impact <s>", "Vaikutus")
        .option("--status <s>", "Tila (Julkaistu/Korjattu/...)")
        .option("--severity <s>", "Bug severity")
        .option("--files <csv>", "Comma-separated file paths")
        .option("--repo <r>", REPO_FLAG_DESC)
        .option("--sha <csv>", "Commit SHAs (CSV)")
        .option("--vtag <s>", "Version tag")
        .option("--bump-level <l>", "App version bump this implies: none|patch|minor|major", "patch")
        .option("--feedback <id>", "cliFeedback id this resolves", Number)
        .option("--sentry <ref>", "Sentry issue short id or URL this fixes")
        .option("--source <s>", "Source: human|routine (default: human)")
        .option("--date <d>", "Entry date (YYYY-MM-DD|today), default today")
        .option("--language <l>", "Entry language (fi|en), default fi")).action(async (description, o) => {
        validateEnums(o.type, o.area, o.bumpLevel, o.source);
        const entryDate = resolveDate(o.date || "today");
        const body = {
            type: o.type,
            area: o.area,
            title: o.title,
            description: resolveChangelogDescription(description, o.description),
            entryDate,
        };
        if (o.benefits)
            body.benefits = o.benefits;
        if (o.impact)
            body.impact = o.impact;
        if (o.status)
            body.status = o.status;
        if (o.severity)
            body.severity = o.severity;
        if (o.files)
            body.files = JSON.stringify(o.files
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean));
        if (o.repo)
            body.repo = o.repo;
        if (o.repo &&
            !COORDINATED_REPOS.includes(o.repo) &&
            (o.bumpLevel || "patch") !== "none")
            console.error(`[ib] ⚠ --repo "${o.repo}" is not a coordinated repo (${COORDINATED_REPOS.join(", ")}) — on next deploy this fail-safe-bumps ALL of them. For the standalone lane (betonicli, @ibetoni/*) add --bump-level none.`);
        if (o.sha)
            body.commitShas = o.sha;
        if (o.vtag)
            body.versionTag = o.vtag;
        if (o.feedback !== undefined)
            body.feedbackId = Number(o.feedback);
        if (o.sentry)
            body.sentryIssue = normalizeSentryRef(o.sentry);
        if (o.source)
            body.source = o.source;
        const addLang = normalizeLanguage(o.language);
        if (addLang)
            body.language = addLang;
        body.bumpLevel = o.bumpLevel || "patch";
        try {
            writeJson(await runChangelogAdd(await getClient(), body, o));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("list")
        .description("List change entries (filters: --month --type --area --repo --feedback --sentry --source --search --status --has-feedback --has-sentry --limit)")
        .option("--month <YYYY-MM>", "Filter to a month")
        .option("--type <t>", "feature|improvement|bugfix")
        .option("--area <a>", "frontend|backend|cli|database|cicd")
        .option("--repo <r>", "Repo/submodule")
        .option("--feedback <id>", "Entries linked to a feedback id", Number)
        .option("--sentry <ref>", "Entries linked to a Sentry issue short id")
        .option("--source <s>", "human|routine")
        .option("--search <text>", "Substring match over title/description/files/commitShas (deploy-gated)")
        .option("--status <substr>", "Substring match on the free-text status field, e.g. 'Deployed' (deploy-gated)")
        .option("--has-feedback", "Only entries linked to a feedback id (deploy-gated)")
        .option("--has-sentry", "Only entries linked to a Sentry issue (deploy-gated)")
        .option("--limit <n>", "Max rows", Number)
        .action(async (o) => {
        try {
            writeJson(await runChangelogList(await getClient(), o));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("get <changelogId>")
        .description("Get one entry")
        .action(async (id) => {
        try {
            writeJson(await runChangelogGet(await getClient(), Number(id)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(c
        .command("update <changelogId>")
        .description("Edit an entry")
        .option("--type <t>", "feature|improvement|bugfix")
        .option("--area <a>", "frontend|backend|cli|database|cicd")
        .option("--title <s>", "New title")
        .option("--description <s>", "New description")
        .option("--benefits <s>", "Hyödyt")
        .option("--impact <s>", "Vaikutus")
        .option("--status <s>", "Status update (e.g. mark deployed)")
        .option("--severity <s>", "Bug severity")
        .option("--files <csv>", "Comma-separated file paths")
        .option("--repo <r>", "Repo/submodule")
        .option("--sha <csv>", "Commit SHAs (CSV)")
        .option("--vtag <s>", "Version tag")
        .option("--source <s>", "Source: human|routine")
        .option("--date <d>", "Entry date (YYYY-MM-DD|today)")
        .option("--language <l>", "Entry language (fi|en)")).action(async (id, o) => {
        validateEnums(o.type, o.area, undefined, o.source);
        const patch = {};
        for (const k of [
            "type",
            "area",
            "title",
            "description",
            "benefits",
            "impact",
            "status",
            "severity",
            "repo",
            "source",
        ]) {
            if (o[k] !== undefined)
                patch[k] = o[k];
        }
        if (o.files)
            patch.files = JSON.stringify(o.files
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean));
        if (o.sha)
            patch.commitShas = o.sha;
        if (o.vtag)
            patch.versionTag = o.vtag;
        if (o.date)
            patch.entryDate = resolveDate(o.date);
        const updLang = normalizeLanguage(o.language);
        if (updLang)
            patch.language = updLang;
        try {
            writeJson(await runChangelogUpdate(await getClient(), Number(id), patch, o));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("report")
        .description("Generate the monthly report from entries (markdown or json)")
        .requiredOption("--month <YYYY-MM>", "Month to render")
        .option("--format <f>", "md|json", "md")
        .action(async (o) => {
        if (!/^\d{4}-\d{2}$/.test(o.month))
            failWith("--month must be YYYY-MM", 4);
        try {
            writeJson(await runChangelogReport(await getClient(), o.month, o.format));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("pending")
        .description("List PENDING/unreleased changelog entries (versionTag IS NULL) staged for the next release, + the max bump level they imply. Drives the deploy-time app version bump.")
        .action(async () => {
        try {
            writeJson(await runChangelogPending(await getClient()));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(c
        .command("release")
        .description("Stamp unreleased entries with a version tag (marks them released). Called by scripts/apply-release-version.ps1. Use --vtag to stamp them all with one tag, or --map for precise per-entry repo@version tags.")
        .option("--vtag <v>", "Single version tag to stamp on every pending entry (e.g. 1.0.8)")
        .option("--map <file>", "JSON file (or - for stdin): [{changelogId, versionTag}] for precise per-entry stamping")).action(async (o) => {
        if ((o.vtag ? 1 : 0) + (o.map ? 1 : 0) !== 1) {
            failWith("provide exactly one of --vtag or --map", 4);
        }
        try {
            if (o.map) {
                let arr;
                try {
                    arr = readJsonInput(o.map);
                }
                catch {
                    failWith("--map: not valid JSON", 4);
                }
                if (!Array.isArray(arr))
                    failWith("--map: JSON root must be an array of {changelogId, versionTag}", 4);
                writeJson(await runChangelogReleaseMap(await getClient(), arr, o));
            }
            else {
                writeJson(await runChangelogRelease(await getClient(), o.vtag, o));
            }
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
export const CHANGELOG_SPECS = [
    {
        command: "ib dev changelog add",
        description: "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row.",
        auth: "any",
        tier: "developer",
        args: [{ name: "description", type: "string", description: "Kuvaus (or pass as --description) — free length, the column is nvarchar(max)" }],
        flags: [
            {
                name: "type",
                type: "string",
                required: true,
                description: "feature|improvement|bugfix",
            },
            {
                name: "area",
                type: "string",
                required: true,
                description: "frontend|backend|cli|database|cicd",
            },
            {
                name: "title",
                type: "string",
                required: true,
                description: "Entry title",
            },
            {
                name: "description",
                type: "string",
                description: "Alias for the positional description; if both are passed, they must match",
            },
            { name: "benefits", type: "string", description: "Hyödyt" },
            { name: "impact", type: "string", description: "Vaikutus" },
            { name: "status", type: "string", description: "Tila (Julkaistu/Korjattu/...)" },
            {
                name: "severity",
                type: "string",
                description: "Bug severity (Kriittinen/Korkea/Normaali/Matala)",
            },
            { name: "files", type: "string", description: "CSV of file paths" },
            { name: "repo", type: "string", description: REPO_FLAG_DESC },
            { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
            { name: "vtag", type: "string", description: "Version tag" },
            { name: "bump-level", type: "string", default: "patch", description: "App version bump this implies: none|patch|minor|major" },
            {
                name: "feedback",
                type: "number",
                description: "cliFeedback id this entry resolves",
            },
            {
                name: "sentry",
                type: "string",
                description: "Sentry issue short id or URL this entry fixes (stored, not sent to Sentry)",
            },
            {
                name: "source",
                type: "string",
                description: "Source: human (default) | routine (automated AI-routine entry)",
            },
            {
                name: "date",
                type: "date",
                description: "Entry date (YYYY-MM-DD|today)",
            },
            { name: "language", type: "string", description: "Entry language (fi|en), default fi" },
        ],
        writeFlags: true,
        mutates: true,
        outputShape: "{ changelogId } | { dryRun, wouldCreate, validation }",
        errors: [
            {
                http: 403,
                exit: 3,
                meaning: "Developer access required",
                remedy: "use a developer token",
            },
            {
                http: 400,
                exit: 4,
                meaning: "Validation (bad enum/date)",
                remedy: "check --type/--area/--date",
            },
            {
                http: 401,
                exit: 2,
                meaning: "Token expired",
                remedy: "ib auth refresh",
            },
        ],
        notes: [
            "You can pass the description either positionally or as --description; if you pass both, they must match (mirrors `ib dev feedback create`).",
            'A description starting with "-" is parsed as an option (exit 4) — put a bare `--` terminator before it: ib dev changelog add --type bugfix --area cli --title "x" -- "-5% render time". Everything after `--` is taken as positional text.',
            "--dry-run is SERVER-side (X-Dry-Run): the backend validates the payload then echoes wouldCreate without inserting — a bad --type/--area/--date still 400s under --dry-run.",
            "Developer-gated.",
        ],
        seeAlso: ["ib dev changelog report", "ib dev feedback resolve"],
        examples: [
            'ib dev changelog add --type bugfix --area cli --title "x" --description "y" --feedback 12 --sha 59d9cc5',
            'ib dev changelog add "positional description works too" --type bugfix --area cli --title "x"',
            'ib dev changelog add --type bugfix --area backend --title "fix npe" --description "y" --sentry PUMINET5API-1A2',
        ],
    },
    {
        command: "ib dev changelog list",
        description: "List change entries with filters.",
        auth: "any",
        tier: "developer",
        flags: [
            { name: "month", type: "string", description: "YYYY-MM" },
            {
                name: "type",
                type: "string",
                description: "feature|improvement|bugfix",
            },
            {
                name: "area",
                type: "string",
                description: "frontend|backend|cli|database|cicd",
            },
            { name: "repo", type: "string", description: "Repo/submodule" },
            {
                name: "feedback",
                type: "number",
                description: "linked feedback id",
            },
            {
                name: "sentry",
                type: "string",
                description: "linked Sentry issue short id",
            },
            { name: "source", type: "string", description: "human|routine" },
            {
                name: "search",
                type: "string",
                description: "Substring match over title/description/files/commitShas (deploy-gated)",
            },
            {
                name: "status",
                type: "string",
                description: "Substring match on the free-text status field, e.g. 'Deployed' (deploy-gated)",
            },
            {
                name: "has-feedback",
                type: "boolean",
                description: "Only entries linked to a feedback id (deploy-gated)",
            },
            {
                name: "has-sentry",
                type: "boolean",
                description: "Only entries linked to a Sentry issue (deploy-gated)",
            },
            { name: "limit", type: "number", description: "Max rows" },
        ],
        outputShape: "ListEnvelope<entry>",
        errors: [
            {
                http: 403,
                exit: 3,
                meaning: "Developer only",
                remedy: "dev token",
            },
        ],
        notes: [
            "--search / --status / --has-feedback / --has-sentry are server-side filters added in a later backend version; against an older backend they are silently ignored (the list returns unfiltered) — deploy-gated.",
        ],
        examples: [
            "ib dev changelog list --month 2026-06 --type feature",
            "ib dev changelog list --search weather",
            "ib dev changelog list --has-feedback --status Deployed",
        ],
    },
    {
        command: "ib dev changelog get",
        description: "Get one change entry.",
        auth: "any",
        tier: "developer",
        args: [
            {
                name: "changelogId",
                type: "number",
                description: "Entry id",
            },
        ],
        flags: [],
        outputShape: "entry",
        errors: [
            {
                http: 403,
                exit: 3,
                meaning: "Developer only",
                remedy: "dev token",
            },
            {
                http: 404,
                exit: 5,
                meaning: "Not found",
                remedy: "ib dev changelog list",
            },
        ],
        examples: ["ib dev changelog get 7"],
    },
    {
        command: "ib dev changelog update",
        description: "Edit a change entry.",
        auth: "any",
        tier: "developer",
        args: [
            {
                name: "changelogId",
                type: "number",
                description: "Entry id",
            },
        ],
        flags: [
            {
                name: "type",
                type: "string",
                description: "feature|improvement|bugfix",
            },
            {
                name: "area",
                type: "string",
                description: "frontend|backend|cli|database|cicd",
            },
            { name: "title", type: "string", description: "New title" },
            { name: "description", type: "string", description: "New description" },
            { name: "benefits", type: "string", description: "Hyödyt" },
            { name: "impact", type: "string", description: "Vaikutus" },
            {
                name: "status",
                type: "string",
                description: "Status update (e.g. mark deployed)",
            },
            { name: "severity", type: "string", description: "Bug severity" },
            { name: "files", type: "string", description: "CSV of file paths" },
            { name: "repo", type: "string", description: "Repo/submodule" },
            { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
            { name: "vtag", type: "string", description: "Version tag" },
            { name: "source", type: "string", description: "Source: human|routine" },
            {
                name: "date",
                type: "date",
                description: "Entry date (YYYY-MM-DD|today)",
            },
            { name: "language", type: "string", description: "Entry language (fi|en)" },
        ],
        writeFlags: true,
        mutates: true,
        outputShape: "entry",
        errors: [
            {
                http: 403,
                exit: 3,
                meaning: "Developer only",
                remedy: "dev token",
            },
            {
                http: 400,
                exit: 4,
                meaning: "Validation (bad enum/language)",
                remedy: "language must be fi|en",
            },
        ],
        examples: [
            'ib dev changelog update 7 --status "Deployed prod"',
            "ib dev changelog update 386 --language en",
        ],
    },
    {
        command: "ib dev changelog report",
        description: "Generate the monthly report (markdown or json) from entries.",
        auth: "any",
        tier: "developer",
        flags: [
            {
                name: "month",
                type: "string",
                required: true,
                description: "YYYY-MM",
            },
            {
                name: "format",
                type: "string",
                default: "md",
                description: "md|json",
            },
        ],
        outputShape: "{ month, markdown } | { month, rows }",
        errors: [
            {
                http: 403,
                exit: 3,
                meaning: "Developer only",
                remedy: "dev token",
            },
        ],
        notes: [
            "--month is required (YYYY-MM); this renders a released monthly report, not the pending queue.",
            "To list UNRELEASED/pending entries staged for the next release, use `ib dev changelog pending` (there is no --unreleased flag here).",
        ],
        seeAlso: ["ib dev changelog pending"],
        examples: ["ib dev changelog report --month 2026-06"],
    },
    {
        command: "ib dev changelog pending",
        description: "List PENDING/unreleased changelog entries (versionTag IS NULL) staged for the next release, + the max bump level they imply. Drives the deploy-time app version bump.",
        auth: "any",
        tier: "developer",
        flags: [],
        outputShape: "{ entries, maxBumpLevel, count }",
        errors: [{ http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" }],
        notes: [
            "This is the unreleased/pending view (mirrors `ib dev feedback list --unresolved`); `ib dev changelog report` needs --month and only covers already-released entries.",
        ],
        seeAlso: ["ib dev changelog report", "ib dev changelog release"],
        examples: ["ib dev changelog pending"],
    },
    {
        command: "ib dev changelog release",
        description: "Stamp unreleased entries with a version tag (marks them released). Called by scripts/apply-release-version.ps1. Use --vtag to stamp them all with one tag, or --map for precise per-entry repo@version tags.",
        auth: "any",
        tier: "developer",
        flags: [
            { name: "vtag", type: "string", description: "Single version tag to stamp on all pending entries (e.g. 1.0.8)" },
            { name: "map", type: "string", description: "JSON file (or -): [{changelogId, versionTag}] for precise per-entry stamping" },
        ],
        writeFlags: true,
        mutates: true,
        outputShape: "{ released, versionTag } | { released, mode:'map' } | { dryRun, wouldRelease }",
        errors: [
            { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
            { http: 400, exit: 4, meaning: "Validation (need --vtag or --map)", remedy: "pass exactly one of --vtag/--map" },
        ],
        notes: [
            "Developer-gated.",
            "Provide exactly one of --vtag (one tag for all) or --map (precise per-entry repo@version).",
            "Typically invoked by scripts/apply-release-version.ps1, not by hand.",
        ],
        examples: [
            "ib dev changelog release --vtag 1.0.8 --reason 'release 1.0.8'",
            "ib dev changelog release --map ./stampMap.json --reason 'release'",
        ],
    },
];
//# sourceMappingURL=index.js.map