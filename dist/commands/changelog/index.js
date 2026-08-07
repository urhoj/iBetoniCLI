import { toListEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { readJsonInput, readJsonObjectInput } from "../../api/parseBody.js";
import { writeJson, failWith, failUsage, failValidation, warnNote } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { parseRefId, assertEnum, intFlag } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { COORDINATED as COORDINATED_REPOS, normalizeRepoCsv } from "./repos.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
const TYPES = ["feature", "improvement", "bugfix"];
const AREAS = ["frontend", "backend", "cli", "database", "cicd"];
const BUMP_LEVELS = ["none", "patch", "minor", "major"];
const LANGUAGES = ["fi", "en"]; // devChangelog.language is CHAR(2) NOT NULL DEFAULT 'en'
const SOURCES = ["human", "routine"];
// COORDINATED_REPOS / normalizeRepoCsv: see ./repos.ts (mirror of the backend
// repo model). Step 0 bumps coordinated repos independently from the max
// --bump-level across the unreleased entries naming them; a --repo whose CSV
// resolves to NO known repo at all fail-safe-bumps EVERY coordinated repo
// (unless --bump-level none). The standalone lane (betonicli, @ibetoni/*)
// versions separately via `npm run final` — target it with --bump-level none.
//
// The lane is decided per-token by computeReleasePlan, NOT by coordinated-set
// membership: `recognizedAny` (canonical.length > 0) short-circuits before the
// fail-safe, so a recognized-but-non-coordinated repo bumps nothing whatever
// --bump-level says. Keep that distinction visible in the help text — collapsing
// it into "unrecognized" is what made fb#354 mis-read a safe call as dangerous.
// The old wording said "an UNRECOGNIZED value fail-safe-bumps ALL coordinated
// repos … for the standalone lane also pass --bump-level none", which reads as
// "not in the coordinated list" and so describes `--repo betonicli` — a value
// that is recognized, bumps nothing, and needs no --bump-level none. A reporter
// believed a routine standalone-lane entry had armed a five-repo bump and filed
// it (feedback #354). Spell the three tiers out, since only the third is armed.
const REPO_FLAG_DESC = "Repo this entry ships in. THREE tiers: (1) coordinated — puminet4|puminet5api|puminet7-functions-app|betonijerry|workspace — each bumped independently on next deploy from the max --bump-level naming it; (2) recognized standalone — betonicli, @ibetoni/*, dbo.*, ibetoni-site, bsg2 — NO app bump at all (--bump-level is inert here; these version via `npm run final`); (3) ⚠ a value resolving to NO known repo at all, which fail-safe-bumps ALL coordinated repos unless --bump-level none.";
const AREA_FLAG_DESC = "Technical layer: frontend|backend|cli|database|cicd (repo granularity goes in --repo, not here)";
// Named once and used by both the Commander options and the specs, so the
// "these two --severity flags are different scales" warning cannot survive on
// one surface and go missing on the other (feedback #359).
const SEVERITY_FLAG_DESC = "Bug severity — Kriittinen|Korkea|Normaali|Matala (an URGENCY ladder; English critical/high/normal/low and the feedback impact words major/minor/cosmetic are accepted and mapped). ⚠ NOT interchangeable with `ib dev feedback --severity` (critical|major|minor|cosmetic), which is an IMPACT ladder with no counterpart for Normaali.";
/**
 * Repo-shaped values agents predictably pass to --area (feedback #212 —
 * `ib feedback --scope` accepts "jerry", so `--area jerry` is a natural first
 * reach when the work is in a specific repo). Maps the mistaken value to the
 * --repo it almost certainly meant, so the validation problem can carry a
 * targeted remedy instead of only the allowed-values list.
 */
const AREA_REPO_REMEDIES = {
    jerry: "betonijerry",
    betonijerry: "betonijerry",
    puminet4: "puminet4",
    puminet5api: "puminet5api",
    "puminet7-functions-app": "puminet7-functions-app",
    workspace: "workspace",
    betonicli: "betonicli",
};
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
    const p = {};
    // CLI option key → API query key. --feedback maps to the backend's `feedbackId`
    // filter; --search/--status are substring LIKE filters (the controller passes
    // req.query straight to listEntries). --has-feedback/--has-sentry are handled below.
    const keyMap = {
        month: "month", type: "type", area: "area", repo: "repo", feedback: "feedbackId",
        sentry: "sentryIssue", source: "source", search: "search", status: "status", limit: "limit",
    };
    for (const [optKey, apiKey] of Object.entries(keyMap))
        p[apiKey] = opts[optKey];
    if (opts.hasFeedback)
        p.hasFeedback = "1";
    if (opts.hasSentry)
        p.hasSentry = "1";
    const rows = await client.get(`/api/changelog${qs(p)}`);
    return toListEnvelope(rows);
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
/**
 * DELETE /api/changelog/:id (backend soft-deletes: sets isDeleted=1). The route
 * has no X-Dry-Run guard, so --dry-run resolves CLIENT-side (echoes wouldDelete,
 * issues no DELETE) — mirrors runChangelogUpdate.
 */
export async function runChangelogDelete(client, id, flags) {
    if (flags.dryRun)
        return { dryRun: true, wouldDelete: { id } };
    return client.delete(`/api/changelog/${id}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runChangelogReport(client, month, format) {
    return client.get(`/api/changelog/report${qs({ month, format })}`);
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
/**
 * Validate the enum flags, reporting ALL bad values at once via the prescriptive
 * validation envelope (feedback #204): each problem carries its allowed values
 * (and, for --type, the accepted synonyms), plus a copy-paste sample resolved
 * from the command's spec — so a caller fixes every enum in one re-run instead
 * of hitting them one at a time. `commandPath` selects which spec (add/update)
 * supplies the sample. (--language is validated separately in normalizeLanguage.)
 */
export function validateEnums(type, area, bumpLevel, source, commandPath = "ib dev changelog add") {
    const problems = [];
    if (type !== undefined && !TYPES.includes(type))
        problems.push({ flag: "--type", issue: "invalid", got: type, allowed: TYPES, synonyms: TYPE_SYNONYMS });
    if (area !== undefined && !AREAS.includes(area)) {
        const repo = AREA_REPO_REMEDIES[area.toLowerCase()];
        problems.push({
            flag: "--area",
            issue: "invalid",
            got: area,
            allowed: AREAS,
            ...(repo
                ? {
                    remedy: `--area is the technical layer, not the repo — pass --repo ${repo} and pick the layer from the allowed values`,
                }
                : {}),
        });
    }
    if (bumpLevel !== undefined && !BUMP_LEVELS.includes(bumpLevel))
        problems.push({ flag: "--bump-level", issue: "invalid", got: bumpLevel, allowed: BUMP_LEVELS });
    if (source !== undefined && !SOURCES.includes(source))
        problems.push({ flag: "--source", issue: "invalid", got: source, allowed: SOURCES });
    if (problems.length)
        failValidation(commandPath, problems, {
            spec: CHANGELOG_SPECS.find((s) => s.command === commandPath),
        });
}
/**
 * Bounded free-text flags → their devChangelog column width (from
 * `ib dev schema table devChangelog`). An over-length value otherwise reaches
 * SQL and surfaces as a raw 500 ("String or binary data would be truncated",
 * feedback #206) instead of a clean client-side validation error. Keyed by the
 * CLI FLAG name (what the caller typed), so `--sha`→commitShas(500) and
 * `--vtag`→versionTag(200). description/benefits/files are nvarchar(max)
 * (unbounded, absent here); --sentry is pre-capped by normalizeSentryRef.
 */
export const FIELD_MAX_LENGTHS = {
    title: 300,
    impact: 500,
    status: 30,
    severity: 20,
    repo: 200,
    sha: 500,
    vtag: 200,
};
/**
 * Stamp each bounded flag's cap onto its own spec description (feedback #330).
 *
 * The caps were documented ONLY in a trailing NOTES line, so a caller composing
 * a payload — especially a `--from-json` file, whose key list repeats the field
 * names without limits — writes an over-length value, gets rejected, trims by
 * estimate, and can be rejected again. Derived from {@link FIELD_MAX_LENGTHS}
 * so the help text can never drift from the validator that enforces it.
 */
function withMaxLengths(flags) {
    return (flags ?? []).map((f) => {
        const cap = FIELD_MAX_LENGTHS[f.name];
        return cap ? { ...f, description: `${f.description} (max ${cap} chars)` } : f;
    });
}
/**
 * Reject over-length free-text flags BEFORE POSTing so they exit 4 (validation)
 * naming each flag + its cap + the actual length, instead of the backend 500ing
 * on "String or binary data would be truncated" (feedback #206). Every offending
 * flag is reported together (aggregated) so the caller fixes them in one re-run.
 * Shared by `add` and `update` (identical flag names). Exits 4; returns void.
 *
 * Uses `failUsage` (NOT bare `failWith`) deliberately: this message already IS
 * the full remedy, and a hintless exit-4 would inherit the command's first
 * client ERRORS row — on `add` that is the argv-mangling row, so a caller who
 * was ALREADY using --from-json got told to use --from-json (feedback #305).
 * The positive hint states the per-flag overflow and explicitly rules that
 * remedy out. Keep the hint; reverting to `failWith` re-opens the dead end.
 */
export function validateFieldLengths(o) {
    const over = [];
    const trims = [];
    for (const [flag, cap] of Object.entries(FIELD_MAX_LENGTHS)) {
        const v = o[flag];
        if (typeof v === "string" && v.length > cap) {
            over.push(`--${flag} is ${v.length} chars (max ${cap})`);
            trims.push(`--${flag} by ${v.length - cap}`);
        }
    }
    if (over.length)
        failUsage(`value too long — ${over.join("; ")}; shorten to fit the devChangelog column`, `trim ${trims.join(", ")} chars — a column-width limit, not shell/argv mangling, so --from-json does not help`);
}
/**
 * Resolve the entry description from the positional, the --description alias,
 * the --summary alias, OR the --body alias (mirrors `ib dev feedback create` —
 * feedback #172/#205/#278; "summary" and "body" are the words an AI reaches for
 * naturally for the entry text, --body being the gh/git convention and already
 * this CLI's name for a free-text body on `message chat send`). All four are
 * equivalent; exactly one value is required, and if several are given they must
 * agree. Exits 4 on conflict or absence.
 */
export function resolveChangelogDescription(positional, flag, summary, body) {
    const given = [positional, flag, summary, body]
        .map((s) => s?.trim())
        .filter((s) => !!s);
    if (new Set(given).size > 1)
        failWith("Provide the description once — via the positional, --description, --summary, or --body; if several are given they must match", 4);
    const description = given[0];
    if (!description)
        failWith("--description (or --summary/--body, or a positional description) is required", 4);
    return description;
}
/**
 * Resolve --sha from itself or its --commit alias (feedback #210 — commit SHAs
 * are near-universally called "commit", so first tries reach for --commit).
 * Both may be given only when they agree. Shared by `add` and `update`; fold in
 * BEFORE validateFieldLengths so the 500-char sha cap applies to the alias too.
 */
export function resolveShaAlias(sha, commit) {
    if (sha !== undefined && commit !== undefined && sha.trim() !== commit.trim())
        failWith("--commit is an alias for --sha — pass one, or identical values", 4);
    return sha ?? commit;
}
/**
 * Conventional-commit synonyms for --type. Commit messages in this codebase use
 * `fix:` / `feat:`, so agents and devs repeatedly pass those to `changelog add`
 * (feedback #188). Map them to the canonical devChangelog enum before validation.
 */
const TYPE_SYNONYMS = { fix: "bugfix", feat: "feature" };
/**
 * Trim + lowercase --type and resolve a conventional-commit synonym
 * (`fix`→`bugfix`, `feat`→`feature`). Unknown values pass through unchanged for
 * validateEnums to reject; undefined passes through as undefined.
 */
export function normalizeType(type) {
    if (type === undefined)
        return undefined;
    const v = type.trim().toLowerCase();
    return TYPE_SYNONYMS[v] ?? v;
}
/**
 * The canonical `--severity` vocabulary — an URGENCY ladder, in Finnish, because
 * that is what the ~90 non-null rows in `devChangelog` already hold.
 *
 * Deliberately NOT the same ladder as `ib dev feedback --severity`
 * (critical|major|minor|cosmetic), which measures IMPACT: `Normaali` has no
 * counterpart there at all, so a value cannot be carried between the two
 * commands by lookup — it has to be re-judged (feedback #359).
 */
const SEVERITIES = ["Kriittinen", "Korkea", "Normaali", "Matala"];
/**
 * Accepted spellings → the canonical Finnish value.
 *
 * Covers the caller's own casing, the English urgency words, and the sibling
 * `feedback --severity` impact enum, which is the vocabulary an agent is most
 * likely to be holding: writing up one fix touches both commands, and guessing
 * wrong on the second cost a round-trip every time (feedback #359 — `Korkea`
 * was carried across as `normal` and rejected). Exactly the forgiveness
 * {@link TYPE_SYNONYMS} already grants `--type` on this same command.
 *
 * `major`→Korkea and `minor`/`cosmetic`→Matala are the honest 4→4 mapping of
 * the impact ladder onto the urgency one; `normal` has no impact-side source
 * and is reachable only from the English urgency word.
 */
const SEVERITY_SYNONYMS = {
    kriittinen: "Kriittinen", critical: "Kriittinen", blocker: "Kriittinen",
    korkea: "Korkea", high: "Korkea", major: "Korkea",
    normaali: "Normaali", normal: "Normaali", medium: "Normaali", moderate: "Normaali",
    matala: "Matala", low: "Matala", minor: "Matala", cosmetic: "Matala",
};
/**
 * Normalize --severity to a canonical Finnish value, or undefined when not passed.
 * Exits 4 on an unknown value.
 *
 * This flag used to be unvalidated free text capped at 20 chars, so a typo — or
 * an English value carried over from `ib dev feedback` — was accepted SILENTLY
 * and persisted into the permanent record the monthly report is generated from.
 * The command with the weaker guarantee was the one whose values were harder to
 * guess (feedback #359). Safe to tighten: the last 400 entries are 100% clean
 * Finnish (Normaali 44 · Korkea 33 · Matala 13 · Kriittinen 1), so validation
 * rejects nothing that is actually in use.
 */
export function normalizeSeverity(severity) {
    if (severity === undefined)
        return undefined;
    const v = severity.trim();
    if (!v)
        return undefined;
    const canonical = SEVERITY_SYNONYMS[v.toLowerCase()];
    if (!canonical)
        failWith(`--severity must be one of: ${SEVERITIES.join(", ")} (an urgency ladder; ` +
            `English critical/high/normal/low and the feedback impact words major/minor/cosmetic are accepted and mapped). ` +
            `Note this is NOT the same scale as \`ib dev feedback --severity\` (critical|major|minor|cosmetic, an IMPACT ladder) — got "${v}"`, 4);
    return canonical;
}
/** Normalize --language to a validated lowercase fi|en, or undefined when not passed. Exits 4 on a bad code. */
export function normalizeLanguage(lang) {
    if (lang === undefined)
        return undefined;
    const v = lang.trim().toLowerCase();
    assertEnum(v, LANGUAGES, "--language");
    return v;
}
// ─── --from-json (fb#300) ────────────────────────────────────────────────────
// A changelog description is long-form prose ABOUT code, so it is the text most
// likely to contain double quotes (quoted identifiers, JSON fragments, error
// strings) — and Windows PowerShell splits a native argument on those inner
// quotes, so the CLI saw N positionals and exited 4 ("too many arguments for
// 'add'"). The entry documenting fb#298/#299 hit exactly that and only filed
// after every quote was stripped from the prose, silently degrading the
// permanent record the monthly report is generated from. --from-json <file|->
// sidesteps argv entirely, mirroring `ib dev feedback create` (fb#299).
/**
 * Option attribute names that are NOT part of the entry payload: the JSON source
 * itself, the write-safety trio, and help. Everything else a command registers is
 * a payload field (see {@link payloadKeyMap}).
 */
const NON_PAYLOAD_OPTS = new Set(["fromJson", "dryRun", "idempotencyKey", "reason", "help"]);
/** Payload fields whose flag takes a CSV — a --from-json array is joined for these. */
const CSV_FIELDS = new Set(["files", "repo", "sha", "commit"]);
/** Payload fields Commander parses with Number. */
const NUMERIC_FIELDS = new Set(["feedback"]);
/**
 * Column name as the READ commands emit it → the write flag that sets it.
 *
 * `--from-json` exists so long prose survives argv (fb#299/#300), and the
 * natural way to author one of those files is to template it off a row from
 * `ib dev changelog list` — that listing is the only place the field set is
 * visible at all. But the read shape is the DB column names and the write keys
 * are the flag names, and five of them differ, so the obvious round-trip
 * (`read a row → edit it → post it back`) exits 4 on the first mismatched key
 * (feedback #357). Accepting the read spelling as INPUT costs one table and
 * changes no output: the emitted shape is untouched, and the flag names stay
 * canonical.
 */
const READ_SHAPE_KEY_ALIASES = {
    commitShas: "sha",
    versionTag: "vtag",
    feedbackId: "feedback",
    sentryIssue: "sentry",
    entryDate: "date",
};
/**
 * JSON key → canonical option attribute name, for every payload flag registered
 * on `cmd`. Derived from the command itself instead of a hand-kept list, so `add`
 * and `update` (different flag sets) each accept exactly the keys they can apply,
 * and a flag added later cannot drift out of --from-json. Three spellings
 * resolve: the camelCase attribute (`bumpLevel`), the literal flag
 * (`bump-level`), and the read-shape column name ({@link READ_SHAPE_KEY_ALIASES})
 * when that flag is registered on this command.
 */
export function payloadKeyMap(cmd) {
    const m = new Map();
    for (const opt of cmd.options) {
        const attr = opt.attributeName();
        if (!opt.long || NON_PAYLOAD_OPTS.has(attr))
            continue;
        m.set(attr, attr);
        m.set(opt.long.replace(/^--/, ""), attr);
    }
    // Gated on the target flag actually existing, so `update` (a different flag
    // set) never silently accepts a read key it cannot apply.
    for (const [readKey, flag] of Object.entries(READ_SHAPE_KEY_ALIASES)) {
        if (m.has(flag) && !m.has(readKey))
            m.set(readKey, m.get(flag));
    }
    return m;
}
/**
 * Normalize a --from-json object into flag-shaped fields.
 *
 * Unknown keys are REJECTED (exit 4), not ignored: the entry is a permanent
 * record, and fb#298 was precisely a silently-dropped JSON key destroying a
 * stored value. Wrong-typed values are rejected by name too — `files: [...]`
 * would otherwise reach `.split(",")` and surface as a raw TypeError (exit 1);
 * the CSV fields therefore also ACCEPT an array, which is what a JSON author
 * naturally writes. Every problem is reported together so one re-run fixes all.
 */
export function normalizeChangelogJson(json, keys) {
    const out = {};
    const unknown = [];
    const problems = [];
    for (const [rawKey, value] of Object.entries(json)) {
        const key = keys.get(rawKey);
        if (!key) {
            unknown.push(rawKey);
            continue;
        }
        if (value === null || value === undefined)
            continue;
        if (NUMERIC_FIELDS.has(key)) {
            const n = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(n))
                problems.push(`"${rawKey}" must be a number`);
            else
                out[key] = n;
            continue;
        }
        if (CSV_FIELDS.has(key) && Array.isArray(value)) {
            if (!value.every((v) => typeof v === "string"))
                problems.push(`"${rawKey}" array must contain only strings`);
            else
                out[key] = value.map((v) => v.trim()).filter(Boolean).join(",");
            continue;
        }
        if (typeof value !== "string") {
            problems.push(`"${rawKey}" must be a string${CSV_FIELDS.has(key) ? " or an array of strings" : ""} (got ${Array.isArray(value) ? "array" : typeof value})`);
            continue;
        }
        out[key] = value;
    }
    if (unknown.length)
        problems.push(`unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — accepted: ${[...new Set(keys.values())].sort().join(", ")}`);
    if (problems.length)
        failUsage(`--from-json: ${problems.join("; ")}`);
    return out;
}
/** The subset of `o` the caller ACTUALLY typed (as opposed to a Commander default). */
export function explicitFlags(cmd, o, keys) {
    const out = {};
    for (const k of keys)
        if (cmd.getOptionValueSource(k) === "cli")
            out[k] = o[k];
    return out;
}
/**
 * Merge a --from-json object with the CLI flags. Precedence: an EXPLICITLY-typed
 * flag wins, then the JSON object, then whatever the option already holds (its
 * Commander default). That middle rung is why `explicit` is passed separately
 * from the raw opts — `--bump-level` declares a default ("patch"), so a naive
 * flags-win merge would let a default the caller never typed outrank a
 * JSON-supplied value (the precedence trap fb#299 hit on --kind/--scope).
 */
export function mergeChangelogInput(json, explicit, defaults = {}) {
    const out = {};
    for (const k of new Set([...Object.keys(defaults), ...Object.keys(json), ...Object.keys(explicit)])) {
        const v = explicit[k] ?? json[k] ?? defaults[k];
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
/**
 * Apply a `--from-json <file|->` payload onto the action's options object, in
 * place. No-op without the flag. Reads the file (or stdin) via the shared
 * shell-safe reader, validates the object against the command's OWN flags, and
 * merges it UNDER the explicitly-typed flags.
 */
export function applyFromJson(cmd, o) {
    if (o.fromJson === undefined)
        return;
    const keys = payloadKeyMap(cmd);
    const json = normalizeChangelogJson(readJsonObjectInput(String(o.fromJson)), keys);
    Object.assign(o, mergeChangelogInput(json, explicitFlags(cmd, o, new Set(keys.values())), o));
}
/**
 * Enforce `add`'s required fields AFTER the --from-json merge.
 *
 * --type/--area/--title are declared as plain options rather than
 * `.requiredOption` because Commander enforces a required option BEFORE any
 * action runs — which would make `add --from-json entry.json` fail no matter what
 * the file contains. They are enforced here instead, aggregated with the
 * description into ONE prescriptive envelope: the same shape the parser layer
 * emits (fb#204), carrying every missing flag, its allowed values, and a
 * copy-paste sample from the spec.
 */
export function requireAddFields(description, o) {
    const has = (v) => typeof v === "string" && v.trim() !== "";
    const problems = [];
    for (const f of ["type", "area", "title"])
        if (!has(o[f]))
            problems.push({ flag: `--${f}`, issue: "missing" });
    if (![description, o.description, o.summary, o.body].some(has))
        problems.push({ flag: "--description", issue: "missing" });
    if (problems.length)
        failValidation("ib dev changelog add", problems, {
            spec: CHANGELOG_SPECS.find((s) => s.command === "ib dev changelog add"),
        });
}
/**
 * Fields the UPDATE route only learned to accept in a later backend version
 * (feedback #303). Against an older deployment the PUT succeeds and echoes the
 * row UNCHANGED — the exact silent-drop this feedback was filed about — so the
 * absence of an error is not evidence the edit landed.
 */
const DEPLOY_GATED_PATCH_FIELDS = ["bumpLevel", "feedbackId", "sentryIssue"];
/**
 * Warn on stderr when the backend echoed back something other than what we sent
 * for a deploy-gated field. The route returns the updated row, so a mismatch
 * means that column is not in the deployed allowlist. stderr only — the stdout
 * JSON contract is untouched. No-op under --dry-run (no row comes back).
 */
export function warnIfPatchIgnored(patch, result, warn = warnNote) {
    if (!result || typeof result !== "object" || result.dryRun)
        return;
    const row = result;
    const ignored = DEPLOY_GATED_PATCH_FIELDS.filter((f) => patch[f] !== undefined && f in row && row[f] !== patch[f]);
    if (ignored.length)
        warn(`[ib] ⚠ the backend did not apply ${ignored.map((f) => `--${f === "feedbackId" ? "feedback" : f === "sentryIssue" ? "sentry" : "bump-level"}`).join(", ")} — ` +
            `these became editable in a later puminet5api version, so this endpoint is silently ignoring them (fb#303). The rest of the patch was applied.`);
}
/**
 * Warn on stderr when --feedback took a row's resolvedByChangelogId away from a
 * DIFFERENT entry.
 *
 * A row's work often lands in more than one entry — a fix, then a follow-up, a
 * revert, a doc pass — and `--feedback` reads as "this entry relates to fb#N",
 * not "this entry is now the sole resolver of fb#N". Re-pointing is still
 * allowed (it is the correction path when the FIRST link was wrong), but it
 * used to be completely silent: the response was a bare {"changelogId":N} and
 * the only way to notice was to go and look. Anyone following the feedback row
 * afterwards lands on the follow-up instead of the fix (fb#366).
 *
 * stderr only — the stdout JSON contract is untouched.
 */
export function warnIfFeedbackRelinked(result, warn = warnNote) {
    if (!result || typeof result !== "object")
        return;
    const { relinkedFrom, changelogId } = result;
    if (typeof relinkedFrom !== "number")
        return;
    warn(`[ib] note: that feedback row was already resolved by cl#${relinkedFrom}; cl#${changelogId} now owns the link. ` +
        `If you meant to cross-reference rather than re-resolve, restore it with \`ib dev changelog update ${relinkedFrom} --feedback <id>\`.`);
}
export function registerChangelogCommands(parent, getClient, opts = {}) {
    const c = parent
        .command("changelog", { hidden: !!opts.hidden })
        .description("Development changelog entries (source of the monthly report)");
    addWriteFlagsToCommand(c
        .command("add [description]")
        // `create` — reciprocal hidden alias: `changelog` is the outlier that uses
        // `add` where every other group uses `create`, so an agent primed on
        // `create` types `changelog create`; accept it (feedback #229).
        .alias("create")
        // Required, but declared as plain options so --from-json can supply them:
        // Commander enforces a .requiredOption before the action runs. Enforced
        // post-merge by requireAddFields (fb#300).
        .option("--type <t>", "feature|improvement|bugfix (accepts fix→bugfix, feat→feature) — required, via flag or --from-json")
        .option("--area <a>", AREA_FLAG_DESC)
        .option("--title <s>", "Entry title — required, via flag or --from-json")
        .option("--description <s>", "Kuvaus — alias for the positional; if both are given, they must match")
        .option("--summary <s>", "Alias for --description (the entry body); if both are given, they must match")
        .option("--body <s>", "Alias for --description (free text, not JSON); if both are given, they must match")
        .option("--benefits <s>", "Hyödyt")
        .option("--impact <s>", "Vaikutus")
        .option("--status <s>", "Tila (Julkaistu/Korjattu/...)")
        .option("--severity <s>", SEVERITY_FLAG_DESC)
        .option("--files <csv>", "Comma-separated file paths")
        .option("--repo <r>", REPO_FLAG_DESC)
        .option("--sha <csv>", "Commit SHAs (CSV)")
        .option("--commit <csv>", "Alias for --sha — Commit SHAs (CSV); if both are given, they must match")
        .option("--vtag <s>", "Version tag")
        .option("--bump-level <l>", "App version bump this implies: none|patch|minor|major", "patch")
        .option("--feedback <id>", "cliFeedback id this resolves", intFlag("--feedback"))
        .option("--sentry <ref>", "Sentry issue short id or URL this fixes")
        .option("--source <s>", "Source: human|routine (default: human)")
        .option("--date <d>", "Entry date (YYYY-MM-DD|today), default today")
        .option("--language <l>", "Entry language (fi|en), default en")
        .option("--from-json <file>", "Read the whole entry from a JSON object file (or - for stdin); explicitly-typed flags override. Shell-safe: the only way to pass prose containing double quotes on Windows PowerShell.")).action(guarded(async (description, o, cmd) => {
        applyFromJson(cmd, o);
        o.type = normalizeType(o.type);
        o.severity = normalizeSeverity(o.severity);
        requireAddFields(description, o);
        validateEnums(o.type, o.area, o.bumpLevel, o.source);
        o.sha = resolveShaAlias(o.sha, o.commit);
        validateFieldLengths(o);
        const entryDate = resolveDate(o.date || "today");
        const body = {
            type: o.type,
            area: o.area,
            title: o.title,
            description: resolveChangelogDescription(description, o.description, o.summary, o.body),
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
        // fb#228: warn only when the deploy planner would actually fail-safe-bump
        // (computeReleasePlan: coordinated=[] AND canonical=[] — nothing in the
        // CSV recognized). Per-token semantics, not a whole-CSV membership test.
        if (o.repo && (o.bumpLevel || "patch") !== "none") {
            const { coordinated, canonical } = normalizeRepoCsv(o.repo);
            if (coordinated.length === 0 && canonical.length === 0)
                warnNote(`[ib] ⚠ --repo "${o.repo}" resolves to no known repo (coordinated: ${COORDINATED_REPOS.join(", ")}) — on next deploy this fail-safe-bumps ALL coordinated repos. For the standalone lane (betonicli, @ibetoni/*) add --bump-level none.`);
            // Recognized standalone lane: the planner skips it entirely, so the
            // --bump-level just recorded will never move a version. Silent today,
            // and the caller has no way to tell it apart from a coordinated entry
            // that WILL bump (feedback #354). One line, same shape as the ⚠ above.
            else if (coordinated.length === 0)
                warnNote(`[ib] note: --repo "${o.repo}" is the standalone lane, so --bump-level ${o.bumpLevel || "patch"} is inert — no repo is bumped by this entry. Coordinated repos are ${COORDINATED_REPOS.join(", ")}; pass --bump-level none to say so explicitly.`);
        }
        if (o.sha)
            body.commitShas = o.sha;
        if (o.vtag)
            body.versionTag = o.vtag;
        if (o.feedback !== undefined)
            body.feedbackId = o.feedback;
        if (o.sentry)
            body.sentryIssue = normalizeSentryRef(o.sentry);
        if (o.source)
            body.source = o.source;
        const addLang = normalizeLanguage(o.language);
        if (addLang)
            body.language = addLang;
        body.bumpLevel = o.bumpLevel || "patch";
        const added = await runChangelogAdd(await getClient(), body, o);
        warnIfFeedbackRelinked(added);
        writeJson(added);
    }));
    c.command("list")
        .option("--month <YYYY-MM>", "Filter to a month")
        .option("--type <t>", "feature|improvement|bugfix")
        .option("--area <a>", AREA_FLAG_DESC)
        .option("--repo <r>", "Repo/submodule")
        .option("--feedback <id>", "Entries linked to a feedback id", intFlag("--feedback"))
        .option("--sentry <ref>", "Entries linked to a Sentry issue short id")
        .option("--source <s>", "human|routine")
        .option("--search <text>", "Substring match over title/description/files/commitShas (deploy-gated)")
        .option("--status <substr>", "Substring match on the free-text status field, e.g. 'Deployed' (deploy-gated)")
        .option("--has-feedback", "Only entries linked to a feedback id (deploy-gated)")
        .option("--has-sentry", "Only entries linked to a Sentry issue (deploy-gated)")
        .option("--unreleased", "List only UNRELEASED/pending entries (versionTag IS NULL) staged for the next release, + the max bump level — routes to `changelog pending`")
        .option("--pending", "Alias for --unreleased")
        .option("--limit <n>", "Max rows", Number)
        .action(guarded(async (o) => {
        // --unreleased/--pending is the pending-queue view, not a month filter;
        // route it to the dedicated endpoint so the literal command an agent
        // reaches for works (feedback #196/#197).
        if (o.unreleased || o.pending) {
            writeJson(await runChangelogPending(await getClient()));
            return;
        }
        writeJson(await runChangelogList(await getClient(), o));
    }));
    c.command("get <changelogId>")
        .action(guarded(async (idStr) => {
        const id = parseRefId(idStr, "changelog", "get");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "feedback", () => runChangelogGet(client, id)));
    }));
    addWriteFlagsToCommand(c
        .command("delete <changelogId>")).action(guarded(async (idStr, o) => {
        const id = parseRefId(idStr, "changelog", "delete");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "feedback", () => runChangelogDelete(client, id, o)));
    }));
    addWriteFlagsToCommand(c
        .command("update <changelogId>")
        .option("--type <t>", "feature|improvement|bugfix (accepts fix→bugfix, feat→feature)")
        .option("--area <a>", AREA_FLAG_DESC)
        .option("--title <s>", "New title")
        .option("--description <s>", "New description")
        .option("--summary <s>", "Alias for --description; if both are given, they must match")
        .option("--body <s>", "Alias for --description (free text, not JSON); if both are given, they must match")
        .option("--benefits <s>", "Hyödyt")
        .option("--impact <s>", "Vaikutus")
        .option("--status <s>", "Status update (e.g. mark deployed)")
        .option("--severity <s>", SEVERITY_FLAG_DESC)
        .option("--files <csv>", "Comma-separated file paths")
        .option("--repo <r>", "Repo/submodule")
        .option("--sha <csv>", "Commit SHAs (CSV)")
        .option("--commit <csv>", "Alias for --sha — Commit SHAs (CSV); if both are given, they must match")
        .option("--vtag <s>", "Version tag")
        // NO default, unlike `add`'s --bump-level (feedback #303). A Commander
        // default here would ride along on every unrelated patch — `update 7
        // --status Deployed` would silently rewrite a deliberate `minor` back to
        // `patch` and mis-drive the next deploy. Absent flag = field untouched.
        .option("--bump-level <l>", "Correct the app version bump this entry implies: none|patch|minor|major. Refused once the entry is RELEASED (has a versionTag) — that bump already shipped.")
        .option("--feedback <id>", "cliFeedback id this entry resolves — also marks that row applied and points it back here (repairs a link orphaned by delete + re-add). Takes the link from a prior resolver, noting it on stderr (fb#366)", intFlag("--feedback"))
        .option("--sentry <ref>", "Sentry issue short id or URL this entry fixes")
        .option("--source <s>", "Source: human|routine")
        .option("--date <d>", "Entry date (YYYY-MM-DD|today)")
        .option("--language <l>", "Entry language (fi|en)")
        .option("--from-json <file>", "Read the patch from a JSON object file (or - for stdin); explicitly-typed flags override. Shell-safe: the only way to pass prose containing double quotes on Windows PowerShell.")).action(guarded(async (idStr, o, cmd) => {
        const id = parseRefId(idStr, "changelog", "update");
        applyFromJson(cmd, o);
        if (o.type !== undefined)
            o.type = normalizeType(o.type);
        if (o.severity !== undefined)
            o.severity = normalizeSeverity(o.severity);
        validateEnums(o.type, o.area, o.bumpLevel, o.source, "ib dev changelog update");
        // --summary/--body are aliases for --description (feedback #205/#278); fold
        // them in before the patch build so the loop below picks them up. Several may
        // be given only when they agree.
        for (const alias of ["summary", "body"]) {
            const v = o[alias];
            if (v === undefined)
                continue;
            if (o.description !== undefined && o.description.trim() !== v.trim())
                failWith("Provide the description via --description, --summary, or --body, not several with different values", 4);
            if (o.description === undefined)
                o.description = v;
        }
        o.sha = resolveShaAlias(o.sha, o.commit);
        validateFieldLengths(o);
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
        if (o.bumpLevel !== undefined)
            patch.bumpLevel = o.bumpLevel;
        if (o.feedback !== undefined)
            patch.feedbackId = o.feedback;
        if (o.sentry)
            patch.sentryIssue = normalizeSentryRef(o.sentry);
        const updLang = normalizeLanguage(o.language);
        if (updLang)
            patch.language = updLang;
        const client = await getClient();
        const result = await runWithSiblingHint(client, id, "feedback", () => runChangelogUpdate(client, id, patch, o));
        warnIfPatchIgnored(patch, result);
        warnIfFeedbackRelinked(result);
        writeJson(result);
    }));
    c.command("report")
        .option("--month <YYYY-MM>", "Month to render")
        .option("--unreleased", "Report UNRELEASED/pending entries staged for the next release instead of a month — routes to `changelog pending`")
        .option("--pending", "Alias for --unreleased")
        .option("--format <f>", "md|json", "md")
        .action(guarded(async (o) => {
        // `report` covers already-RELEASED months; the unreleased/pending queue
        // has its own endpoint. Accept --unreleased/--pending here so the
        // natural `report --unreleased` an agent tries works instead of dead-
        // ending on "required option --month" (feedback #196/#197).
        if (o.unreleased || o.pending) {
            writeJson(await runChangelogPending(await getClient()));
            return;
        }
        if (!o.month)
            failWith("--month <YYYY-MM> is required for a monthly report. For UNRELEASED/pending entries staged for the next release, use `ib dev changelog pending` (or `report --unreleased`).", 4);
        if (!/^\d{4}-\d{2}$/.test(o.month))
            failWith("--month must be YYYY-MM", 4);
        assertEnum(o.format, ["md", "json"], "--format");
        writeJson(await runChangelogReport(await getClient(), o.month, o.format));
    }));
    c.command("pending")
        .action(jsonAction(getClient, runChangelogPending));
    addWriteFlagsToCommand(c
        .command("release")
        .option("--vtag <v>", "Single version tag to stamp on every pending entry (e.g. 1.0.8)")
        .option("--map <file>", "JSON file (or - for stdin): [{changelogId, versionTag}] for precise per-entry stamping")).action(guarded(async (o) => {
        if ((o.vtag ? 1 : 0) + (o.map ? 1 : 0) !== 1) {
            failWith("provide exactly one of --vtag or --map", 4);
        }
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
    }));
}
export const CHANGELOG_SPECS = [
    {
        command: "ib dev changelog add",
        aliases: ["ib dev changelog create"],
        description: "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row to status=applied.",
        auth: "any",
        tier: "developer",
        args: [{ name: "description", type: "string", description: "Kuvaus (or pass as --description) — free length, the column is nvarchar(max)" }],
        flags: withMaxLengths([
            {
                name: "type",
                type: "string",
                required: true,
                allowed: TYPES,
                synonyms: TYPE_SYNONYMS,
                description: "feature|improvement|bugfix (conventional-commit synonyms accepted: fix→bugfix, feat→feature)",
            },
            {
                name: "area",
                type: "string",
                required: true,
                allowed: AREAS,
                description: AREA_FLAG_DESC,
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
            {
                name: "summary",
                type: "string",
                description: "Alias for --description (the entry body); if both are passed, they must match",
            },
            {
                name: "body",
                type: "string",
                description: "Alias for --description (the entry body, free text — NOT the raw-JSON --body of the update commands); if both are passed, they must match",
            },
            { name: "benefits", type: "string", description: "Hyödyt" },
            { name: "impact", type: "string", description: "Vaikutus" },
            { name: "status", type: "string", description: "Tila (Julkaistu/Korjattu/...)" },
            {
                name: "severity",
                type: "string",
                description: SEVERITY_FLAG_DESC,
            },
            { name: "files", type: "string", description: "CSV of file paths" },
            { name: "repo", type: "string", description: REPO_FLAG_DESC },
            { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
            { name: "commit", type: "string", description: "Alias for --sha — Commit SHAs (CSV); if both are given, they must match" },
            { name: "vtag", type: "string", description: "Version tag" },
            { name: "bump-level", type: "string", default: "patch", allowed: BUMP_LEVELS, description: "App version bump this implies: none|patch|minor|major" },
            {
                name: "feedback",
                type: "number",
                description: "cliFeedback id this entry resolves — also marks that row applied and points resolvedByChangelogId here. If the row was ALREADY resolved by another entry, this TAKES the link (the correction path for a wrong first link) and says so on stderr; any hand-written resolution note is preserved (fb#366).",
            },
            {
                name: "sentry",
                type: "string",
                description: "Sentry issue short id or URL this entry fixes (stored, not sent to Sentry)",
            },
            {
                name: "source",
                type: "string",
                allowed: SOURCES,
                description: "Source: human (default) | routine (automated AI-routine entry)",
            },
            {
                name: "date",
                type: "date",
                description: "Entry date (YYYY-MM-DD|today)",
            },
            { name: "language", type: "string", allowed: LANGUAGES, description: "Entry language (fi|en), default en" },
            {
                name: "from-json",
                type: "string",
                description: "Read the whole entry from a JSON object file (or - for stdin); explicitly-typed flags override. Keys are the flag names in camelCase: description (or summary/body), title (≤300), type, area, benefits, impact (≤500), status (≤30), severity (≤20), files, repo (≤200), sha (≤500), commit, vtag (≤200), bumpLevel (`bump-level` also accepted), feedback, sentry, source, date, language. files/repo/sha/commit also accept an array of strings. The READ shape is also accepted as input, so a row from `ib dev changelog list` can be edited and posted straight back: commitShas→sha, versionTag→vtag, feedbackId→feedback, sentryIssue→sentry, entryDate→date. An unknown or wrong-typed key exits 4 (never silently dropped). The length caps apply to a JSON value exactly as to a flag — --from-json sidesteps shell quoting, not column width.",
            },
        ]),
        writeFlags: true,
        mutates: true,
        outputShape: "{ changelogId, relinkedFrom? } | { dryRun, wouldCreate, validation }. `relinkedFrom` appears only when --feedback named a row already resolved by a DIFFERENT entry, and carries that entry's id; a one-line note also goes to stderr.",
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
            {
                origin: "client",
                exit: 4,
                match: "too many arguments",
                meaning: "too many arguments — the shell split a quoted flag value on its inner double-quotes (typical on Windows PowerShell)",
                remedy: "Pass the whole entry via --from-json <file|-> instead of argv",
            },
            {
                origin: "client",
                exit: 4,
                match: "--from-json",
                meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key",
                remedy: "Check the path; the root must be an object and every key an accepted field name (the error lists them)",
            },
            {
                origin: "client",
                exit: 4,
                match: "value too long",
                meaning: "a bounded free-text flag exceeds its devChangelog column width",
                remedy: "trim the named flag by the stated overflow — a column-width limit, so --from-json does not help",
            },
        ],
        notes: [
            "You can pass the description positionally, as --description, or as its --summary/--body aliases — if you pass more than one they must match (mirrors `ib dev feedback create`). Here --body is FREE TEXT, unlike the raw-JSON --body on the entity update commands.",
            'SHELL QUOTING (fb#300): an entry description is long-form prose ABOUT code, so it is the text most likely to contain double quotes (quoted identifiers, JSON fragments, error strings) — and Windows PowerShell splits a native argument on those inner quotes, so the CLI sees many positionals and exits 4 with "too many arguments". --from-json <file|-> sidesteps argv entirely and is the recommended path for any quote-bearing entry; stripping the quotes instead silently degrades the permanent record. --type/--area/--title are required but may come from the JSON.',
            'A description starting with "-" is parsed as an option (exit 4) — put a bare `--` terminator before it: ib dev changelog add --type bugfix --area cli --title "x" -- "-5% render time". Everything after `--` is taken as positional text.',
            "--dry-run is SERVER-side (X-Dry-Run): the backend validates the payload then echoes wouldCreate without inserting — a bad --type/--area/--date still 400s under --dry-run.",
            "Bounded free-text flags are length-checked client-side (exit 4) before POSTing: --status ≤30, --severity ≤20, --title ≤300, --impact ≤500, --repo/--vtag ≤200, --sha ≤500. (--description/--benefits/--files are unbounded.)",
            "--feedback on a row that is ALREADY resolved TAKES the link from the earlier entry. That is intended (it is how a wrong first link gets corrected), but a row's work often spans several entries — a fix, then a follow-up, a revert, a doc pass — so a cross-reference silently becomes the sole resolver and a reader following the feedback row lands on the follow-up instead of the fix. The response now carries `relinkedFrom` and stderr names the displaced entry; restore it with `ib dev changelog update <thatId> --feedback <id>` (fb#366).",
            "DEPLOY-GATED (fb#366): `relinkedFrom` and its stderr note come from a later puminet5api version. Against an older backend the re-link still happens and is still SILENT — check the row with `ib dev feedback get <id>` after linking an already-resolved one.",
            "Developer-gated.",
        ],
        seeAlso: ["ib dev changelog report", "ib dev feedback resolve"],
        examples: [
            'ib dev changelog add --type bugfix --area cli --title "x" --description "y" --feedback 12 --sha 59d9cc5',
            'ib dev changelog add "positional description works too" --type bugfix --area cli --title "x"',
            'ib dev changelog add --type feature --area backend --title "x" --body "gh-style --body works as a --description alias"',
            'ib dev changelog add --type bugfix --area backend --title "fix npe" --description "y" --sentry PUMINET5API-1A2',
            "ib dev changelog add --from-json ./entry.json",
            "ib dev changelog add --from-json ./entry.json --bump-level minor",
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
                description: AREA_FLAG_DESC,
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
            {
                name: "unreleased",
                type: "boolean",
                description: "List only UNRELEASED/pending entries (versionTag IS NULL) + the max bump level — routes to `changelog pending`",
            },
            { name: "pending", type: "boolean", description: "Alias for --unreleased" },
            { name: "limit", type: "number", description: "Max rows" },
        ],
        outputShape: "ListEnvelope<entry> | (with --unreleased) { items, entries, maxBumpLevel, count }",
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
            "--unreleased/--pending ignores every other filter and returns the pending queue (`changelog pending`): the entries that drive the next deploy's per-repo version bump, plus the implied max bump level.",
        ],
        examples: [
            "ib dev changelog list --month 2026-06 --type feature",
            "ib dev changelog list --search weather",
            "ib dev changelog list --has-feedback --status Deployed",
            "ib dev changelog list --unreleased",
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
                description: "Entry id — accepts an optional `cl#` anchor (e.g. `cl#858`); a `fb#` id is rejected (exit 4) with the feedback command to use (feedback #230)",
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
                remedy: "ib dev changelog list — a bare id that is actually a feedback id 404s here and the error hint names the feedback command (feedback #230)",
            },
        ],
        examples: ["ib dev changelog get 7", "ib dev changelog get cl#7"],
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
                description: "Entry id — accepts an optional `cl#` anchor (e.g. `cl#858`); a `fb#` id is rejected (exit 4) with the feedback command to use (feedback #230)",
            },
        ],
        flags: withMaxLengths([
            {
                name: "type",
                type: "string",
                description: "feature|improvement|bugfix (conventional-commit synonyms accepted: fix→bugfix, feat→feature)",
            },
            {
                name: "area",
                type: "string",
                description: AREA_FLAG_DESC,
            },
            { name: "title", type: "string", description: "New title" },
            { name: "description", type: "string", description: "New description" },
            { name: "summary", type: "string", description: "Alias for --description; if both are passed, they must match" },
            { name: "body", type: "string", description: "Alias for --description (free text, not JSON); if both are passed, they must match" },
            { name: "benefits", type: "string", description: "Hyödyt" },
            { name: "impact", type: "string", description: "Vaikutus" },
            {
                name: "status",
                type: "string",
                description: "Status update (e.g. mark deployed)",
            },
            { name: "severity", type: "string", description: SEVERITY_FLAG_DESC },
            { name: "files", type: "string", description: "CSV of file paths" },
            { name: "repo", type: "string", description: "Repo/submodule" },
            { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
            { name: "commit", type: "string", description: "Alias for --sha — Commit SHAs (CSV); if both are given, they must match" },
            { name: "vtag", type: "string", description: "Version tag" },
            {
                name: "bump-level",
                type: "string",
                allowed: BUMP_LEVELS,
                description: "Correct the app version bump this entry implies: none|patch|minor|major. NO default — omitting it leaves the recorded level untouched. Refused once the entry is RELEASED (has a versionTag).",
            },
            {
                name: "feedback",
                type: "number",
                description: "cliFeedback id this entry resolves — also marks that row applied and sets resolvedByChangelogId back to this entry. Taking the link from a prior resolver is noted on stderr and echoed as `relinkedFrom`; a hand-written resolution note is preserved (fb#366).",
            },
            {
                name: "sentry",
                type: "string",
                description: "Sentry issue short id or URL this entry fixes (stored, not sent to Sentry)",
            },
            { name: "source", type: "string", description: "Source: human|routine" },
            {
                name: "date",
                type: "date",
                description: "Entry date (YYYY-MM-DD|today)",
            },
            { name: "language", type: "string", description: "Entry language (fi|en)" },
            {
                name: "from-json",
                type: "string",
                description: "Read the patch from a JSON object file (or - for stdin); explicitly-typed flags override. Keys are the flag names in camelCase (description/summary/body, title, type, area, benefits, impact, status, severity, files, repo, sha, commit, vtag, bumpLevel (`bump-level` also accepted), feedback, sentry, source, date, language); files/repo/sha/commit also accept an array of strings. The READ shape is also accepted as input (commitShas→sha, versionTag→vtag, feedbackId→feedback, sentryIssue→sentry, entryDate→date), so a row from `ib dev changelog list` can be edited and posted straight back. An unknown or wrong-typed key exits 4 (never silently dropped).",
            },
        ]),
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
            {
                http: 400,
                exit: 4,
                meaning: "--bump-level on an already-RELEASED entry (one carrying a versionTag) — that bump has already shipped",
                remedy: "Leave it as recorded; every other field is still editable. Only UNRELEASED entries (ib dev changelog pending) still drive a deploy.",
            },
            {
                origin: "client",
                exit: 4,
                match: "--from-json",
                meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key",
                remedy: "Check the path; the root must be an object and every key an accepted field name (the error lists them)",
            },
            {
                origin: "client",
                exit: 4,
                match: "value too long",
                meaning: "a bounded free-text flag exceeds its devChangelog column width",
                remedy: "trim the named flag by the stated overflow — a column-width limit, so --from-json does not help",
            },
        ],
        notes: [
            "SHELL QUOTING (fb#300): this is the command used to CORRECT an entry, which is exactly the retry that hits the quoting hazard again — Windows PowerShell splits a native argument on inner double-quotes. Pass quote-bearing prose via --from-json <file|-> rather than stripping the quotes.",
            "THE CORRECTION PATH FOR --bump-level (fb#303). Deploy Step 0 bumps each coordinated repo from the MAX bump level across the UNRELEASED entries naming it, so a wrong level mis-drives a real release. Fix it here — do NOT delete + re-add, which mints a new changelogId and orphans the cliFeedback row pointing at the old one.",
            "--bump-level has NO default here (unlike `add`, where it defaults to patch): omitting it leaves the recorded level untouched, so an unrelated `update --status …` cannot silently downgrade a deliberate minor.",
            "--feedback also marks that cliFeedback row applied and sets resolvedByChangelogId back to this entry — the only way to re-establish a link lost to delete + re-add (`ib dev feedback resolve` sets status/resolution but not the link).",
            "DEPLOY-GATED: --bump-level/--feedback/--sentry became editable in a later puminet5api version. Against an older backend the PUT succeeds and echoes the row unchanged; the CLI compares the echo and warns on stderr rather than letting the edit vanish silently.",
        ],
        seeAlso: ["ib dev changelog pending", "ib dev changelog get"],
        examples: [
            'ib dev changelog update 7 --status "Deployed prod"',
            "ib dev changelog update 386 --language en",
            'ib dev changelog update 386 --bump-level none --reason "docs-only, should not bump"',
            "ib dev changelog update 386 --from-json ./patch.json",
        ],
    },
    {
        command: "ib dev changelog delete",
        description: "Soft-delete a change entry (isDeleted=1; retained for audit, hidden from all reads, no CLI undelete).",
        auth: "any",
        tier: "developer",
        args: [{ name: "changelogId", type: "number", description: "Entry id — accepts an optional `cl#` anchor (e.g. `cl#858`); a `fb#` id is rejected (exit 4) with the feedback command to use (feedback #230)" }],
        flags: [],
        writeFlags: true,
        mutates: true,
        outputShape: "{ deleted: true } | { dryRun, wouldDelete }",
        errors: [
            { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
            { http: 404, exit: 5, meaning: "Not found (or already deleted)", remedy: "ib dev changelog list — a bare id that is actually a feedback id 404s here and the error hint names the feedback command (feedback #230)" },
        ],
        notes: [
            "Soft-delete: sets isDeleted=1 — the row is kept for audit but hidden from every read (get/list/report/pending), and there is no CLI undelete.",
            "Deleting an already-released entry (one with a versionTag) removes it from that month's generated report.",
            "--dry-run resolves CLIENT-side (echoes wouldDelete, issues no DELETE); the backend route has no X-Dry-Run guard.",
            "Deleting an already-deleted/missing id returns 404 (exit 5), not a no-op.",
            "Developer-gated.",
        ],
        seeAlso: ["ib dev changelog update", "ib dev changelog get"],
        examples: [
            'ib dev changelog delete 805 --reason "test entry cleanup"',
            "ib dev changelog delete 805 --dry-run",
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
                description: "YYYY-MM (required unless --unreleased)",
            },
            {
                name: "unreleased",
                type: "boolean",
                description: "Report UNRELEASED/pending entries staged for the next release instead of a month — routes to `changelog pending`",
            },
            { name: "pending", type: "boolean", description: "Alias for --unreleased" },
            {
                name: "format",
                type: "string",
                default: "md",
                description: "md|json",
            },
        ],
        outputShape: "{ month, markdown } | { month, rows } | (with --unreleased) { items, entries, maxBumpLevel, count }",
        errors: [
            {
                http: 403,
                exit: 3,
                meaning: "Developer only",
                remedy: "dev token",
            },
            {
                origin: "client",
                exit: 4,
                meaning: "Neither --month nor --unreleased given (or bad --month)",
                remedy: "pass --month YYYY-MM for a released month, or --unreleased for the pending queue",
            },
        ],
        notes: [
            "--month (YYYY-MM) renders a released monthly report; --unreleased/--pending instead returns the pending queue (`changelog pending`) staged for the next release. Exactly one is needed.",
        ],
        seeAlso: ["ib dev changelog pending"],
        examples: [
            "ib dev changelog report --month 2026-06",
            "ib dev changelog report --unreleased",
        ],
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
            "This is the unreleased/pending view (mirrors `ib dev feedback list --unresolved`). `ib dev changelog list --unreleased` and `ib dev changelog report --unreleased` are aliases that route here; `report --month` covers already-released months.",
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