import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { qs } from "../../api/query.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { addJsonBodyOptions } from "../_shared/jsonBody.js";
import { intFlag, parseId } from "../../targets.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { resolveDate, resolveDateTime, todayHelsinki } from "../../dates.js";
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
const HHMM_RE = /^\d{2}:\d{2}$/;
/**
 * Helsinki wall-clock `date` + `HH:MM` → ISO instant (the web grid's own wire
 * format). Goes through resolveDateTime so DST is handled the same way as
 * every other `--time` flag.
 */
export function composeInstant(date, hhmm, flag) {
    if (!HHMM_RE.test(hhmm))
        failWith(`${flag}: expected HH:MM, got "${hhmm}"`, 4);
    return resolveDateTime(`${date}T${hhmm}`, flag);
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
function palkkiTypeFieldsFromOpts(opts, isUpdate) {
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
    // Commander's --no-X sets opts.X = false only when the negated form was
    // registered (update); on create a plain --job is true|undefined.
    const negatable = (v) => (isUpdate ? v : v ? true : undefined);
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
        isInventoryTransfer: negatable(opts.inventoryTransfer),
        isJob: negatable(opts.job),
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
 * Register `ib palkki` — grid bars (palkit) and their type catalogue.
 *
 *   list | get | create | update | delete            /api/cli/palkki/*
 *   type list                                        /api/cli/palkki/type/list
 *   type create | update | delete                    /api/grid/palkkiType/*
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
        const body = await resolvePalkkiTypeCreateBody(client, parsed, palkkiTypeFieldsFromOpts(opts, false));
        writeJson(await runPalkkiTypeCreate(client, body, opts));
    }));
    addWriteFlagsToCommand(addPalkkiTypeFlags(t.command("update <palkkiTypeId>"), true)).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        const body = buildPalkkiTypeBody(parsed, palkkiTypeFieldsFromOpts(opts, true));
        writeJson(await runPalkkiTypeUpdate(client, parseId(idStr, "palkkiTypeId"), body, opts));
    }));
    addWriteFlagsToCommand(t.command("delete <palkkiTypeId>")).action(jsonAction(getClient, (client, idStr, opts) => runPalkkiTypeDelete(client, parseId(idStr, "palkkiTypeId"), opts)));
}
//# sourceMappingURL=index.js.map