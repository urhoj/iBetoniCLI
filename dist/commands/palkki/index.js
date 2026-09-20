import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { qs } from "../../api/query.js";
import { toListEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { addJsonBodyOptions } from "../_shared/jsonBody.js";
import { intFlag, parseId } from "../../targets.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { resolveDate, todayHelsinki, composeInstant } from "../../dates.js";
/**
 * Merge typed convenience flags over a parsed --body object (typed flags win).
 * The body shape is shared by POST /grid/palkkiType/new and /save/:id — the
 * update route accepts this create-route vocabulary and merges it over the row.
 */
export function buildPalkkiTypeBody(parsedBody, typed) {
    const body = { ...parsedBody };
    if (typed.name !== undefined)
        body.name = typed.name;
    if (typed.description !== undefined)
        body.unit = typed.description;
    if (typed.owner !== undefined)
        body.ownerAsiakasId = typed.owner;
    if (typed.active !== undefined)
        body.isActive = typed.active;
    if (typed.vehicleAvailable !== undefined)
        body.vehicleAvailable = typed.vehicleAvailable;
    if (typed.sortNo !== undefined)
        body.sortNo = typed.sortNo;
    if (typed.showReportKlo !== undefined)
        body.showReportKlo = typed.showReportKlo;
    if (typed.reportStyle !== undefined)
        body.reportStyle = typed.reportStyle;
    if (typed.showInReport !== undefined)
        body.showInReport = typed.showInReport;
    if (typed.isInventoryTransfer !== undefined)
        body.isInventoryTransfer = typed.isInventoryTransfer;
    if (typed.isJob !== undefined)
        body.isJob = typed.isJob;
    return body;
}
/**
 * {@link buildPalkkiTypeBody} plus the ownerAsiakasId default: resolved to the
 * active company only when the merged body still has none (fb#1659) — an
 * ownerAsiakasId already present in --body/--from-json must not be clobbered.
 */
export async function resolvePalkkiTypeCreateBody(client, parsedBody, typed) {
    const body = buildPalkkiTypeBody(parsedBody, typed);
    if (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null) {
        body.ownerAsiakasId = await resolveActiveOwnerAsiakasId(client, "pass --owner");
    }
    return body;
}
/**
 * POST /grid/palkkiType/new. `body.name` is REQUIRED (the backend falls back
 * to a placeholder name otherwise, which is never what a caller wants) —
 * checked here so the failure is a clear exit 4 instead of a silently wrong row.
 */
export async function runPalkkiTypeCreate(client, body, flags) {
    if (typeof body.name !== "string" || !body.name.trim()) {
        failWith("create requires: --name (grid_palkkiType)", 4);
    }
    return client.post("/api/grid/palkkiType/new", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** POST /grid/palkkiType/save/:id — PARTIAL (the backend read-merges over the row). */
export async function runPalkkiTypeUpdate(client, palkkiTypeId, body, flags) {
    if (Object.keys(body).length === 0) {
        failWith("Nothing to update: pass at least one field flag (or --body/--from-json)", 4);
    }
    return client.post(`/api/grid/palkkiType/save/${palkkiTypeId}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runPalkkiTypeDelete(client, palkkiTypeId, flags) {
    return client.delete(`/api/grid/palkkiType/delete/${palkkiTypeId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runPalkkiTypeList(client, opts) {
    return client.get(`/api/cli/palkki/type/list${qs({ owner: opts.owner, all: opts.all ? 1 : undefined })}`);
}
/** Merge typed convenience flags over a parsed --body object (typed flags win). */
export function buildPalkkiColorBody(parsedBody, typed) {
    const body = { ...parsedBody };
    if (typed.title !== undefined)
        body.title = typed.title;
    if (typed.ehto !== undefined)
        body.ehto = typed.ehto;
    if (typed.style !== undefined)
        body.style = typed.style;
    if (typed.comment !== undefined)
        body.comment = typed.comment;
    if (typed.sortNo !== undefined)
        body.sortNo = typed.sortNo;
    if (typed.owner !== undefined)
        body.ownerAsiakasId = typed.owner;
    if (typed.active !== undefined)
        body.isActive = typed.active;
    if (typed.iconName !== undefined)
        body.iconName = typed.iconName;
    if (typed.iconText !== undefined)
        body.iconText = typed.iconText;
    if (typed.iconColor !== undefined)
        body.iconColor = typed.iconColor;
    if (typed.iconBackgroundColor !== undefined)
        body.iconBackgroundColor = typed.iconBackgroundColor;
    return body;
}
/**
 * {@link buildPalkkiColorBody} plus the ownerAsiakasId default: resolved to the
 * active company only when the merged body still has none — an ownerAsiakasId
 * already present in --body/--from-json must not be clobbered (mirrors
 * resolvePalkkiTypeCreateBody, fb#1659).
 */
export async function resolvePalkkiColorCreateBody(client, parsedBody, typed) {
    const body = buildPalkkiColorBody(parsedBody, typed);
    if (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null) {
        body.ownerAsiakasId = await resolveActiveOwnerAsiakasId(client, "pass --owner");
    }
    return body;
}
/**
 * GET /api/grid/barColors/list/:ownerAsiakasId — a bare array with a REQUIRED
 * path param (unlike `palkki type list`'s dedicated CLI route), projected here
 * into the standard list envelope.
 */
export async function runPalkkiColorList(client, opts) {
    const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner"));
    const raw = await client.get(`/api/grid/barColors/list/${owner}`);
    return toListEnvelope(raw);
}
/**
 * No dedicated "get one" endpoint exists server-side — resolve by listing the
 * row's owner and filtering client-side (exit 5 if not found in that owner's
 * list). Also the shared lookup `delete`/`reorder --dry-run` use to preview
 * without ever sending the write, and `reorder` uses live to resolve both
 * rows' current sortNo (the backend swap endpoint has no lookup of its own).
 */
export async function runPalkkiColorGet(client, barColorId, opts = {}) {
    const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner"));
    const rows = await client.get(`/api/grid/barColors/list/${owner}`);
    const row = (rows ?? []).find((r) => r.barColorId === barColorId);
    if (!row) {
        failWith(`barColorId ${barColorId} not found for owner ${owner}`, 5, "check the id with `ib palkki color list`, or pass --owner if it belongs to a different company");
    }
    return row;
}
/** POST /grid/barColors/save with no barColorId (create). `body.title` is REQUIRED. */
export async function runPalkkiColorCreate(client, body, flags) {
    if (typeof body.title !== "string" || !body.title.trim()) {
        failWith("create requires: --title", 4);
    }
    if (flags.dryRun)
        return { dryRun: true, wouldCreate: body };
    return client.post("/api/grid/barColors/save", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * POST /grid/barColors/save with barColorId set — PARTIAL (the backend
 * read-merges over the row). `--owner` on `palkki color update` re-homes the
 * row; the --dry-run preview lookup below always resolves under the ACTIVE
 * company (re-homing a row you can't yet see under your own company is not
 * supported by this preview).
 */
export async function runPalkkiColorUpdate(client, barColorId, body, flags) {
    if (Object.keys(body).length === 0) {
        failWith("Nothing to update: pass at least one field flag (or --body/--from-json)", 4);
    }
    if (flags.dryRun) {
        const existing = await runPalkkiColorGet(client, barColorId);
        return { dryRun: true, wouldUpdate: { ...existing, ...body, barColorId } };
    }
    return client.post("/api/grid/barColors/save", { ...body, barColorId }, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** DELETE /grid/barColors/delete/:id. --dry-run resolves locally (get first — 404s as exit 5 if missing — no DELETE issued). */
export async function runPalkkiColorDelete(client, barColorId, flags, opts = {}) {
    if (flags.dryRun) {
        await runPalkkiColorGet(client, barColorId, opts);
        return { dryRun: true, wouldDelete: { barColorId } };
    }
    return client.delete(`/api/grid/barColors/delete/${barColorId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Swaps sortNo between two bar-coloring rules (the FE's adjacent up/down
 * reorder). POST /grid/barColors/reorder blindly assigns whatever sortNo
 * values it is given — no server-side lookup — so both rows' CURRENT sortNo
 * are resolved first via `runPalkkiColorGet`, scoped to the same --owner
 * (default: active company); a barColorId2 that isn't in that owner's list
 * exits 5 locally before any write is attempted.
 */
export async function runPalkkiColorReorder(client, barColorId1, barColorId2, flags, opts = {}) {
    const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner"));
    const [row1, row2] = await Promise.all([
        runPalkkiColorGet(client, barColorId1, { owner }),
        runPalkkiColorGet(client, barColorId2, { owner }),
    ]);
    const swapBody = { barColorId1, sortNo1: row2.sortNo, barColorId2, sortNo2: row1.sortNo };
    if (flags.dryRun)
        return { dryRun: true, wouldReorder: swapBody };
    return client.post("/api/grid/barColors/reorder", swapBody, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Merge typed flags over a parsed --body object (typed flags win) into the
 * POST /api/cli/palkki/create|update body. Time flags are composed only when
 * `date` is known — for a partial update the action fills the missing
 * date/start/end components from the existing row first.
 */
export function buildPalkkiBody(parsedBody, typed) {
    const body = { ...parsedBody };
    if (typed.vehicle !== undefined)
        body.vehicleId = typed.vehicle;
    if (typed.type !== undefined)
        body.type = typed.type;
    if (typed.text !== undefined)
        body.text = typed.text;
    if (typed.keikka !== undefined)
        body.attachedKeikkaId = typed.keikka;
    if (typed.worksite !== undefined)
        body.tyomaaId = typed.worksite;
    if (typed.owner !== undefined)
        body.ownerAsiakasId = typed.owner;
    if (typed.style !== undefined)
        body.style = typed.style;
    if (typed.date !== undefined) {
        if (typed.start !== undefined)
            body.timeStart = composeInstant(typed.date, typed.start, "--start");
        if (typed.end !== undefined)
            body.timeEnd = composeInstant(typed.date, typed.end, "--end");
    }
    return body;
}
export async function runPalkkiList(client, opts) {
    return client.get(`/api/cli/palkki/list${qs({
        date: opts.date,
        from: opts.from,
        to: opts.to,
        vehicle: opts.vehicle,
        owner: opts.owner,
        source: opts.source,
        deleted: opts.deleted ? 1 : undefined,
    })}`);
}
export async function runPalkkiGet(client, palkkiId) {
    return client.get(`/api/cli/palkki/get/${palkkiId}`);
}
/** POST /api/cli/palkki/create — `vehicleId`, `type` and both times are required (the server 400s otherwise). */
export async function runPalkkiCreate(client, body, flags) {
    const missing = ["vehicleId", "type", "timeStart", "timeEnd"].filter((k) => body[k] === undefined);
    if (missing.length) {
        failWith(`create requires: ${missing.join(", ")} — pass --vehicle, --type, --date (+ --start/--end)`, 4);
    }
    return client.post("/api/cli/palkki/create", body, { headers: writeFlagsToHeaders(flags) });
}
/** POST /api/cli/palkki/update/:id — PARTIAL (the backend read-merges over the row). */
export async function runPalkkiUpdate(client, palkkiId, body, flags) {
    if (Object.keys(body).length === 0) {
        failWith("Nothing to update: pass at least one field flag (or --body/--from-json)", 4);
    }
    return client.post(`/api/cli/palkki/update/${palkkiId}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * DELETE /api/cli/palkki/delete/:id. The live route answers with the proc's
 * (empty) result set — `null` on the wire — so project a real ack; a dry-run
 * envelope passes through untouched.
 */
export async function runPalkkiDelete(client, palkkiId, flags) {
    const res = await client.delete(`/api/cli/palkki/delete/${palkkiId}`, {
        headers: writeFlagsToHeaders(flags),
    });
    return res ?? { deleted: true, palkkiId };
}
function addPalkkiTypeFlags(cmd, isUpdate) {
    const c = addJsonBodyOptions(cmd)
        .option("--name <n>", isUpdate ? "grid_palkkiType" : "grid_palkkiType (REQUIRED)")
        .option("--description <d>", "grid_palkkiTypeDescription")
        .option("--owner <id>", isUpdate ? "Move to ownerAsiakasId (must be a company you belong to)" : "Owning ownerAsiakasId (defaults to active company; 0 = the shared/global catalog, sysadmin/developer only)", intFlag("--owner", 0))
        .option("--inactive", isUpdate ? "active = false" : "Create as active=false (default: active)");
    if (isUpdate)
        c.option("--active", "active = true");
    c.option("--vehicle-available", "vehicleAvailable = true" + (isUpdate ? "" : " (default)"))
        .option("--vehicle-unavailable", "vehicleAvailable = false")
        .option("--sort-no <n>", isUpdate ? "sortNo" : "Explicit sortNo (default: MAX(sortNo)+10)", intFlag("--sort-no", 0))
        .option("--show-report-time", "showReportKlo = true" + (isUpdate ? "" : " (default)"))
        .option("--hide-report-time", "showReportKlo = false")
        .option("--report-style <css>", "reportStyle — a raw CSS-in-JS fragment applied to the grid bar, e.g. 'fontWeight: \"bold\",'")
        .option("--show-in-report", "showInReport = true" + (isUpdate ? "" : " (default)"))
        .option("--hide-in-report", "showInReport = false")
        .option("--inventory-transfer", "isInventoryTransfer = true" + (isUpdate ? "" : " (default: false) — a palkki of this type auto-creates a delivery record"))
        .option("--job", "isJob = true" + (isUpdate ? "" : " (default: false)"));
    if (isUpdate)
        c.option("--no-inventory-transfer", "isInventoryTransfer = false").option("--no-job", "isJob = false");
    return c;
}
function palkkiTypeFieldsFromOpts(opts) {
    const pairs = [
        [opts.vehicleAvailable, opts.vehicleUnavailable, "--vehicle-available / --vehicle-unavailable"],
        [opts.showReportTime, opts.hideReportTime, "--show-report-time / --hide-report-time"],
        [opts.showInReport, opts.hideInReport, "--show-in-report / --hide-in-report"],
        [opts.active, opts.inactive, "--active / --inactive"],
    ];
    for (const [a, b, label] of pairs)
        if (a && b)
            failWith(`Pass at most one of ${label}`, 4);
    const tri = (on, off) => (on ? true : off ? false : undefined);
    // --job / --inventory-transfer read true|undefined on create; on update the
    // registered --no-X twin makes them true|false|undefined — pass through as-is.
    return {
        name: opts.name,
        description: opts.description,
        owner: opts.owner,
        active: tri(opts.active, opts.inactive),
        vehicleAvailable: tri(opts.vehicleAvailable, opts.vehicleUnavailable),
        sortNo: opts.sortNo,
        showReportKlo: tri(opts.showReportTime, opts.hideReportTime),
        reportStyle: opts.reportStyle,
        showInReport: tri(opts.showInReport, opts.hideInReport),
        isInventoryTransfer: opts.inventoryTransfer,
        isJob: opts.job,
    };
}
function addPalkkiColorFlags(cmd, isUpdate) {
    const c = addJsonBodyOptions(cmd)
        .option("--title <t>", isUpdate ? "title" : "title (REQUIRED)")
        .option("--ehto <expr>", "ehto — the keikkaEval condition this rule matches against a keikka; evaluated by the web grid only (no local or server-side syntax check)")
        .option("--style <css>", 'style — a raw CSS-in-JS fragment applied to the grid bar, e.g. \'backgroundColor: "#f44336",\'')
        .option("--comment <c>", "comment — free-text note, not shown in the grid")
        .option("--sort-no <n>", "sortNo — evaluation order (first matching active rule wins); default: the row's own id", intFlag("--sort-no", 0))
        .option("--owner <id>", isUpdate
        ? "Move to ownerAsiakasId (must be a company you belong to)"
        : "Owning ownerAsiakasId (defaults to active company; 0 = the shared/global catalog, sysadmin/developer only)", intFlag("--owner", 0))
        .option("--icon-name <name>", "iconName — icon shown on the bar when this rule matches")
        .option("--icon-text <letters>", "iconText — 1-2 letters (e.g. BV) shown in the bar's circle INSTEAD of the icon when set; empty string clears")
        .option("--icon-color <css>", "iconColor")
        .option("--icon-background-color <css>", "iconBackgroundColor");
    if (isUpdate)
        c.option("--active", "isActive = true");
    c.option("--inactive", isUpdate ? "isActive = false" : "Create as isActive=false (default: active)");
    return c;
}
function palkkiColorFieldsFromOpts(opts) {
    if (opts.active && opts.inactive)
        failWith("Pass at most one of --active / --inactive", 4);
    const tri = (on, off) => (on ? true : off ? false : undefined);
    return {
        title: opts.title,
        ehto: opts.ehto,
        style: opts.style,
        comment: opts.comment,
        sortNo: opts.sortNo,
        owner: opts.owner,
        active: tri(opts.active, opts.inactive),
        iconName: opts.iconName,
        iconText: opts.iconText,
        iconColor: opts.iconColor,
        iconBackgroundColor: opts.iconBackgroundColor,
    };
}
function addPalkkiFlags(cmd, isUpdate) {
    return addJsonBodyOptions(cmd)
        .option("--vehicle <id>", isUpdate ? "Move to vehicleId" : "vehicleId (REQUIRED)", intFlag("--vehicle"))
        .option("--date <date>", isUpdate ? "Move to this day (YYYY-MM-DD | today | tomorrow)" : "Day (YYYY-MM-DD | today | tomorrow; default: today)")
        .option("--start <HH:MM>", isUpdate ? "New start time (Helsinki)" : "Start time, Helsinki wall-clock (default: 07:00)")
        .option("--end <HH:MM>", isUpdate ? "New end time (Helsinki)" : "End time, Helsinki wall-clock (default: 16:00)")
        .option("--type <name|id>", isUpdate ? "Palkki type name or id" : "Palkki type name or id (REQUIRED) — `ib palkki type list`")
        .option("--text <text>", "Bar text")
        .option("--keikka <id>", "attachedKeikkaId — link the bar to a keikka", intFlag("--keikka"))
        .option("--worksite <id>", "tyomaaId — destination for an inventory-transfer type", intFlag("--worksite"))
        .option("--owner <id>", isUpdate ? "Re-home to ownerAsiakasId (edit role needed in BOTH companies)" : "ownerAsiakasId (default: active company)", intFlag("--owner"))
        .option("--style <css>", "style — CSS-in-JS fragment for this bar");
}
function palkkiFieldsFromOpts(opts) {
    return {
        vehicle: opts.vehicle,
        date: opts.date !== undefined ? resolveDate(opts.date) : undefined,
        start: opts.start,
        end: opts.end,
        type: opts.type,
        text: opts.text,
        keikka: opts.keikka,
        worksite: opts.worksite,
        owner: opts.owner,
        style: opts.style,
    };
}
/**
 * Register `ib palkki` — grid bars (palkit), their type catalogue, and their
 * condition-based coloring rules.
 *
 *   list | get | create | update | delete            /api/cli/palkki/*
 *   type list                                        /api/cli/palkki/type/list
 *   type create | update | delete                    /api/grid/palkkiType/*
 *   color list | get | create | update | delete |     /api/grid/barColors/*
 *     reorder
 *
 * Driver assignment on a palkki stays on `ib vehicle driver assign` (it keeps
 * personPvm / keikkaPerson / palkkiPerson in sync for the whole vehicle-day).
 */
export function registerPalkkiCommands(parent, getClient) {
    const p = parent.command("palkki").description("Palkki (grid bar) commands");
    p.command("list")
        .option("--date <date>", "One day (YYYY-MM-DD | today | tomorrow); default: today")
        .option("--from <date>", "Range start (YYYY-MM-DD)")
        .option("--to <date>", "Range end (YYYY-MM-DD, default: --from)")
        .option("--vehicle <id>", "Only this vehicleId", intFlag("--vehicle"))
        .option("--owner <id>", "Company whose palkit to list (default: active company)", intFlag("--owner"))
        .option("--source <id>", "Also include bars whose sourceAsiakasId is this company", intFlag("--source"))
        .option("--deleted", "Include soft-deleted bars")
        .action(jsonAction(getClient, (client, opts) => {
        if (opts.date && (opts.from || opts.to))
            failWith("Pass either --date or --from/--to, not both", 4);
        if (opts.to && !opts.from)
            failWith("--to needs --from (a range start); for one day use --date", 4);
        const from = resolveDate(opts.from);
        return runPalkkiList(client, {
            ...opts,
            date: !from ? resolveDate(opts.date ?? "today") : undefined,
            from,
            to: resolveDate(opts.to),
        });
    }));
    p.command("get <palkkiId>")
        .alias("show")
        .action(jsonAction(getClient, (client, idStr) => runPalkkiGet(client, parseId(idStr, "palkkiId"))));
    addWriteFlagsToCommand(addPalkkiFlags(p.command("create"), false)).action(guarded(async (opts) => {
        const client = await getClient();
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const typed = palkkiFieldsFromOpts(opts);
        typed.date ??= todayHelsinki();
        typed.start ??= "07:00";
        typed.end ??= "16:00";
        const body = buildPalkkiBody(parsed, typed);
        if (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null) {
            body.ownerAsiakasId = await resolveActiveOwnerAsiakasId(client, "pass --owner");
        }
        writeJson(await runPalkkiCreate(client, body, opts));
    }));
    addWriteFlagsToCommand(addPalkkiFlags(p.command("update <palkkiId>"), true)).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const palkkiId = parseId(idStr, "palkkiId");
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const typed = palkkiFieldsFromOpts(opts);
        // A time move needs all three of date/start/end to compose instants —
        // fill whatever was not given from the existing row.
        if (typed.date !== undefined || typed.start !== undefined || typed.end !== undefined) {
            const cur = await runPalkkiGet(client, palkkiId);
            typed.date ??= cur.date;
            typed.start ??= cur.start;
            typed.end ??= cur.end;
        }
        writeJson(await runPalkkiUpdate(client, palkkiId, buildPalkkiBody(parsed, typed), opts));
    }));
    addWriteFlagsToCommand(p.command("delete <palkkiId>")).action(jsonAction(getClient, (client, idStr, opts) => runPalkkiDelete(client, parseId(idStr, "palkkiId"), opts)));
    const t = p.command("type").description("Palkki type (grid bar/annotation category) commands");
    t.command("list")
        .option("--owner <id>", "Company whose types to list (default: active company); shared owner-0 rows are always included", intFlag("--owner"))
        .option("--all", "Include inactive types")
        .action(jsonAction(getClient, (client, opts) => runPalkkiTypeList(client, opts)));
    addWriteFlagsToCommand(addPalkkiTypeFlags(t.command("create"), false)).action(guarded(async (opts) => {
        const client = await getClient();
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const body = await resolvePalkkiTypeCreateBody(client, parsed, palkkiTypeFieldsFromOpts(opts));
        writeJson(await runPalkkiTypeCreate(client, body, opts));
    }));
    addWriteFlagsToCommand(addPalkkiTypeFlags(t.command("update <palkkiTypeId>"), true)).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const body = buildPalkkiTypeBody(parsed, palkkiTypeFieldsFromOpts(opts));
        writeJson(await runPalkkiTypeUpdate(client, parseId(idStr, "palkkiTypeId"), body, opts));
    }));
    addWriteFlagsToCommand(t.command("delete <palkkiTypeId>")).action(jsonAction(getClient, (client, idStr, opts) => runPalkkiTypeDelete(client, parseId(idStr, "palkkiTypeId"), opts)));
    const c = p.command("color").description("Palkki color (bar coloring rule) commands");
    c.command("list")
        .option("--owner <id>", "Company whose bar-coloring rules to list (default: active company)", intFlag("--owner", 0))
        .action(jsonAction(getClient, (client, opts) => runPalkkiColorList(client, opts)));
    c.command("get <barColorId>")
        .alias("show")
        .option("--owner <id>", "Company to look the row up under (default: active company)", intFlag("--owner", 0))
        .action(jsonAction(getClient, (client, idStr, opts) => runPalkkiColorGet(client, parseId(idStr, "barColorId"), opts)));
    addWriteFlagsToCommand(addPalkkiColorFlags(c.command("create"), false)).action(guarded(async (opts) => {
        const client = await getClient();
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const body = await resolvePalkkiColorCreateBody(client, parsed, palkkiColorFieldsFromOpts(opts));
        writeJson(await runPalkkiColorCreate(client, body, opts));
    }));
    addWriteFlagsToCommand(addPalkkiColorFlags(c.command("update <barColorId>"), true)).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const body = buildPalkkiColorBody(parsed, palkkiColorFieldsFromOpts(opts));
        writeJson(await runPalkkiColorUpdate(client, parseId(idStr, "barColorId"), body, opts));
    }));
    addWriteFlagsToCommand(c.command("delete <barColorId>"))
        .option("--owner <id>", "Company to look the row up under for --dry-run (default: active company); ignored on a live delete", intFlag("--owner", 0))
        .action(jsonAction(getClient, (client, idStr, opts) => runPalkkiColorDelete(client, parseId(idStr, "barColorId"), opts, { owner: opts.owner })));
    addWriteFlagsToCommand(c.command("reorder <barColorId1> <barColorId2>"))
        .option("--owner <id>", "Company both rows belong to (default: active company)", intFlag("--owner", 0))
        .action(jsonAction(getClient, (client, id1Str, id2Str, opts) => runPalkkiColorReorder(client, parseId(id1Str, "barColorId1"), parseId(id2Str, "barColorId2"), opts, { owner: opts.owner })));
}
//# sourceMappingURL=index.js.map