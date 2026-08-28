// ohje specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { clearHint, apiErr, COMMON_AUTH_ERRORS, intParseErr, assessWriteFlags, needsReviewFlags } from "./shared.js";

export const OHJE_SPECS: CommandSpec[] = [

  // ─── ohje (4) — UI help-text content (helps table behind HelperIcon) ──────
  {
    command: "ib ohje get",
    aliases: ["ib ohje show"],
    description:
      "Get one UI help-text entry by helpId — the title/shorttext/htmltext shown in a HelperIcon '(?)' modal in the web UI. This is end-user help CONTENT, distinct from `ib --help` (CLI usage). Returns null when the helpId has no entry yet. The HTTP route is unauthenticated, but ib calls it with your session token (login still required).",
    auth: "any",
    args: [{ name: "helpId", type: "string", description: "the helpId (e.g. LaskupohjaTilaus)" }],
    flags: [],
    outputShape: "{ helpId, title, shorttext, htmltext, img } | null",
    errors: [
      { origin: "client", exit: 4, meaning: "Invalid helpId", remedy: "helpId must be 1–250 characters" },
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib ohje get LaskupohjaTilaus", "ib ohje get LaskupohjaTilaus --pretty"],
  },
  {
    command: "ib ohje list",
    description:
      "List every UI help-text entry (the whole helps table). Useful to discover helpIds before `ib ohje get`/`update`. The full table is LARGE (~115 KB — every row's htmltext), so AI callers should shape it CLIENT-SIDE: --empty-shorttext (grooming backfill targets), --fields (column projection that drops the big htmltext), --sort field:dir. Order applied: filter → sort → limit → project. The HTTP route is unauthenticated, but ib calls it with your session token.",
    auth: "any",
    flags: [
      { name: "limit", type: "number", description: "Max rows to return (client-side cap, after filter+sort)" },
      { name: "search", type: "string", description: "Case-insensitive substring over helpId + title + shorttext — the reflex filter every other list command has (fb#607). Applied CLIENT-SIDE like the rest, and BEFORE --limit, so a search plus a limit returns the first N MATCHES rather than searching the first N rows. htmltext is deliberately not searched: a body-text hit would return a row without showing why it matched." },
      { name: "empty-shorttext", type: "boolean", description: "Only rows whose shorttext is blank (grooming backfill targets)" },
      { name: "fields", type: "string", description: "Comma-separated columns to keep, e.g. helpId,title,shorttext,accessCount (drops the large htmltext)" },
      { name: "sort", type: "string", description: "Sort by a column, e.g. accessCount:desc (numeric fields compare numerically)" },
      ...needsReviewFlags("help row", "oldest-first by lastModifiedTime"),
    ],
    outputShape: "ListEnvelope<{ helpId, title, shorttext, htmltext, img, accessCount, aiConfidence, needsHumanReview, … }> (rows projected to --fields when set)",
    errors: [intParseErr("--limit", "pass a positive integer"), apiErr(500, "Backend error", "retry with --verbose")],
    examples: [
      "ib ohje list --limit 10 --pretty",
      "ib ohje list --empty-shorttext --fields helpId,title,accessCount --sort accessCount:desc",
      "ib ohje list --needs-review --fields helpId,title,aiConfidence,shorttext",
    ],
  },
  {
    command: "ib ohje update",
    description:
      "Update a UI help-text entry (PUT /api/helps/update). The CLI GET-merges the current row first, so fields you omit are PRESERVED (helps_save overwrites the whole row). Provide typed flags or --body JSON; typed flags win. --reason is required for a write. Mirrors the HelperIcon in-place editor.",
    permissions: ["isHelperEditor (or system-admin/developer)"],
    args: [{ name: "helpId", type: "string", description: "the helpId to update (created if it does not exist)" }],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON with any of title/shorttext/htmltext/img (typed flags win)",
      },
      { name: "title", type: "string", description: "Help title (otsikko)" },
      { name: "shorttext", type: "string", description: "Short text" },
      { name: "htmltext", type: "string", description: "Modal body — rendered as MARKDOWN (react-markdown + GFM), NOT HTML despite the column name. Use markdown (**bold**, - bullets, blank line = paragraph); raw <p>/<ul> tags show literally." },
      { name: "img", type: "string", description: "Image reference (" + clearHint("--img") + ", to null)" },
      { name: "must-exist", type: "boolean", description: "Fail (exit 4) instead of creating a new row when the helpId has no entry — guards against a typo'd helpId silently spawning a junk row" },
      ...assessWriteFlags("help row"),
      { name: "field", type: "string", description: "Edit-mode target field: title | shorttext | htmltext (default htmltext)" },
      { name: "replace", type: "string", description: "Edit mode: replace this literal text in the target field (exactly once unless --all)" },
      { name: "with", type: "string", description: 'Replacement for --replace (empty deletes the matched text; ' + clearHint("--with") + ")" },
      { name: "append", type: "string", description: "Edit mode: append text to the target field (verbatim)" },
      { name: "prepend", type: "string", description: "Edit mode: prepend text to the target field (verbatim)" },
      { name: "all", type: "boolean", description: "With --replace: substitute every occurrence" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape:
      "{ success: true, helpId, created, written: {helpId,title,shorttext,htmltext,img, aiConfidence?, needsHumanReview?}, htmltextLength, response } — `created` is true when no prior row existed (a parallel groomer can spot an unexpected insert); aiConfidence/needsHumanReview present in `written` only when those flags were passed; or { dryRun: true, helpId, created, current, proposed } | edit dry-run: {dryRun:true, helpId, field, matchCount?, addedLines, removedLines, sameContent, unified}",
    notes: [
      "aiConfidence/needsHumanReview are DIRECT-assigned, unlike the content fields (title/shorttext/htmltext), which the save proc COALESCEs — an omitted content field keeps its current value, but omitting --ai-confidence or --needs-human-review on ANY write resets the score to null and un-parks the row, re-opening it for the grooming routine. Pass --no-needs-human-review to make that reset explicit in the command line rather than implicit via omission.",
    ],
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason / invalid helpId / --must-exist on a missing row", remedy: "pass --reason; helpId 1–250 chars; drop --must-exist to create" },
      { origin: "client", exit: 5, meaning: "helpId has no existing row (edit mode only)", remedy: "create the entry first with a full --htmltext/--title/--shorttext" },
      apiErr(400, "Validation failed", "title ≤500, htmltext ≤10000, helpId 1–250 chars"),
      apiErr(403, "Permission denied", "needs isHelperEditor or system-admin/developer"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      'ib ohje update LaskupohjaTilaus --title "Laskupohja" --htmltext "<p>Ohje…</p>" --reason "content fix"',
      'ib ohje update LaskupohjaTilaus --dry-run --title "New title"',
      'ib ohje update "käyttöikä" --shorttext "Betonin käyttöikä" --must-exist --reason groom',
      'ib ohje update tila:2 --append "<p>Lisätieto…</p>" --reason "expand help" --dry-run',
    ],
  },
  {
    command: "ib ohje delete",
    description:
      "Delete a UI help-text entry (DELETE /api/helps/delete/:helpId). Removes orphan (stale-named) or empty data-driven helpIds — a missing help row just makes its HelperIcon render nothing (graceful absence), so deleting an empty/unused row is safe. --reason is required for a write. --dry-run previews the row that WOULD be deleted CLIENT-SIDE without issuing the DELETE (works before the backend route deploys). Idempotent: a missing row returns deleted:false. Requires isHelperEditor or system-admin/developer.",
    permissions: ["isHelperEditor (or system-admin/developer)"],
    args: [{ name: "helpId", type: "string", description: "the helpId to delete" }],
    flags: [],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape:
      "{ success: true, helpId, deleted: boolean } — deleted is false when no row existed (idempotent); or { dryRun: true, helpId, wouldDelete: {helpId,title,shorttext,htmltext,img}|null } with --dry-run",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason / invalid helpId", remedy: "pass --reason; helpId 1–250 chars" },
      apiErr(403, "Permission denied", "needs isHelperEditor or system-admin/developer"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Backend route is deploy-gated: DELETE /api/helps/delete/:helpId 404s until puminet5api ships it. --dry-run works immediately (resolved client-side via a GET).",
    ],
    examples: [
      'ib ohje delete sendIlmoitusButton --reason "orphan: button renamed to sendNotificationsButton"',
      "ib ohje delete koekappale --dry-run",
    ],
  },
];
