import { listEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith, warnNote } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { parseId, parseOptionalId, cappedInt, addOwnerOption } from "../../targets.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { CHANGE_ENTITY_TYPES, findEntityType, isKnownEntityType, runLogTypes, } from "./entityTypes.js";
import { qs } from "../../api/query.js";
import { projectChangeRow, } from "./changeRow.js";
function assertKnownEntityType(entityType) {
    if (!isKnownEntityType(entityType)) {
        failWith(`unknown entityType '${entityType}'. Valid: ` +
            CHANGE_ENTITY_TYPES.map((e) => e.entityType).join(", ") +
            ". See `ib log types`.", 4);
    }
    const info = findEntityType(entityType);
    if (info.deprecated) {
        // Diagnostic on stderr (stdout stays pure JSON data).
        warnNote(`note: entityType '${entityType}' is deprecated — ${info.notes}`);
    }
}
/** Accepts YYYY-MM-DD or a full ISO datetime; anything else is exit 4. */
function assertIsoDate(value, flag) {
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ||
        isNaN(Date.parse(value))) {
        failWith(`${flag} must be YYYY-MM-DD or an ISO datetime (got '${value}').`, 4);
    }
}
function envelope(items, truncated = false, hint) {
    const out = listEnvelope(items);
    if (truncated)
        out.truncated = true;
    if (hint)
        out.hint = hint;
    return out;
}
/**
 * True when a SERVER-limited read came back with a full page. These routes cap at
 * `?limit=` and return no cursor, so a full page is the only available "there may
 * be more" signal — without it a capped result is indistinguishable from a
 * complete history, which is exactly what an AI reads it as.
 *
 * (`range`/`by-entity-date` don't use this: they have no server limit, so
 * {@link runChangeWindow} slices client-side and knows the real total.)
 */
const isCapped = (rows, limit) => rows.length >= limit;
/**
 * The read every `ib log` subcommand performs: resolve the owner (all five
 * routes are `/:owner`-scoped, defaulting to the active company), GET, and
 * normalise a non-array body to `[]`. `path` is a builder because the owner is
 * part of the route, not a query param.
 */
async function getChanges(client, path, owner) {
    const resolved = owner ?? (await resolveActiveOwnerAsiakasId(client));
    const rows = await client.get(path(resolved));
    return Array.isArray(rows) ? rows : [];
}
/**
 * The two date-window routes (`range`, `by-entity-date`) differ only in their
 * route segment and query params: both have NO server row limit, so both slice
 * client-side to protect AI context and flag `truncated` when rows were cut.
 *
 * Each caller keeps its OWN guards — their order differs (`range` validates
 * dates then entityType, `by-entity-date` the reverse), and which error a bad
 * invocation reports is part of the contract.
 */
async function runChangeWindow(client, segment, params, opts) {
    const rows = await getChanges(client, (owner) => `/api/changes/${segment}/${owner}${qs(params)}`, opts.owner);
    const sliced = rows.slice(0, opts.limit);
    return envelope(sliced.map(projectChangeRow), sliced.length < rows.length);
}
/** GET /api/changes/:entityType/:entityId/:owner — generic entity history. */
export async function runLogEntity(client, entityType, entityId, limit, opts = {}) {
    assertKnownEntityType(entityType);
    const rows = await getChanges(client, (owner) => `/api/changes/${entityType}/${entityId}/${owner}?limit=${limit}`, opts.owner);
    const capped = isCapped(rows, limit);
    // --field filters CLIENT-side, after the server's limit: the backend route
    // takes only `limit` (changeTrackingRoutes getChangeHistory). So on a capped
    // page the filter ran over the newest `limit` changes only, and an empty
    // result means "not in this window" — NOT "this field never changed". Say so,
    // or the caller reads a false negative as fact.
    const list = opts.field ? rows.filter((r) => r.fieldName === opts.field) : rows;
    const hint = opts.field && capped
        ? `--field ${opts.field} was applied client-side to the newest ${limit} changes only; older changes to it are not shown. Raise --limit (max 500) or use \`ib log by-entity-date\` to search a date window.`
        : undefined;
    return envelope(list.map(projectChangeRow), capped, hint);
}
/** GET /api/changes/latest/:owner — admin-only, newest first, server cap 500. */
export async function runLogLatest(client, limit, opts = {}) {
    if (opts.entityType)
        assertKnownEntityType(opts.entityType);
    const rows = await getChanges(client, (owner) => `/api/changes/latest/${owner}${qs({ limit, entityType: opts.entityType || undefined })}`, opts.owner);
    return envelope(rows.map(projectChangeRow), isCapped(rows, limit));
}
/** GET /api/changes/range/:owner — admin-only, by change timestamp. */
export async function runLogRange(client, opts) {
    assertIsoDate(opts.from, "--from");
    assertIsoDate(opts.to, "--to");
    if (opts.entityType)
        assertKnownEntityType(opts.entityType);
    return runChangeWindow(client, "range", {
        startDate: opts.from,
        endDate: opts.to,
        entityType: opts.entityType || undefined,
        personId: opts.person ?? undefined,
    }, opts);
}
/**
 * GET /api/changes/by-entity-date/:owner — admin-only. Filters by the
 * ENTITY's date (keikka.pumppuAika / grid_palkit.starttime), not the change
 * timestamp: "changes affecting that day's deliveries".
 */
export async function runLogByEntityDate(client, opts) {
    if (!["keikka", "palkki"].includes(opts.entityType)) {
        failWith(`--entity-type must be keikka or palkki for by-entity-date (got '${opts.entityType}').`, 4);
    }
    assertIsoDate(opts.from, "--from");
    assertIsoDate(opts.to, "--to");
    return runChangeWindow(client, "by-entity-date", { startDate: opts.from, endDate: opts.to, entityType: opts.entityType }, opts);
}
/**
 * `ib log user [personId]` — no arg: own recent changes
 * (GET /api/changes/user/recent/:owner); with personId: that person's changes
 * (GET /api/changes/user/:personId/:owner — self or admin).
 */
export async function runLogUser(client, personId, limit, opts = {}) {
    const rows = await getChanges(client, (owner) => personId == null
        ? `/api/changes/user/recent/${owner}?limit=${limit}`
        : `/api/changes/user/${personId}/${owner}?limit=${limit}`, opts.owner);
    return envelope(rows.map(projectChangeRow), isCapped(rows, limit));
}
/** Registers a thin `log <id>` alias on an entity group, delegating to runLogEntity. */
export function registerLogAlias(group, getClient, entityType, idArgName, fieldExample = "Filter by changeTracker fieldName") {
    addOwnerOption(group.command(`log <${idArgName}>`))
        .option("--limit <n>", "", cappedInt(500), 100)
        .option("--field <name>", fieldExample)
        .action(jsonAction(getClient, (client, idStr, opts) => runLogEntity(client, entityType, parseId(idStr, "entityId"), opts.limit, {
        owner: opts.owner,
        field: opts.field,
    })));
}
export function registerLogCommands(parent, getClient) {
    const c = parent.command("log").description("ChangeTracker (audit trail) reads");
    addOwnerOption(c.command("entity <entityType> <entityId>"))
        .option("--limit <n>", "", cappedInt(500), 100)
        .option("--field <name>")
        .action(jsonAction(getClient, (client, entityType, entityIdStr, opts) => runLogEntity(client, entityType, parseId(entityIdStr, "entityId"), opts.limit, { owner: opts.owner, field: opts.field })));
    addOwnerOption(c.command("latest").option("--entity-type <type>"))
        .option("--limit <n>", "", cappedInt(500), 100)
        .action(jsonAction(getClient, (client, opts) => runLogLatest(client, opts.limit, {
        entityType: opts.entityType,
        owner: opts.owner,
    })));
    addOwnerOption(c
        .command("range")
        .requiredOption("--from <iso>")
        .requiredOption("--to <iso>")
        .option("--entity-type <type>")
        .option("--person <personId>", "", (v) => Number(v)))
        .option("--limit <n>", "", cappedInt(2000), 200)
        .action(jsonAction(getClient, (client, opts) => runLogRange(client, {
        from: resolveDate(opts.from) ?? opts.from,
        to: resolveDate(opts.to) ?? opts.to,
        entityType: opts.entityType,
        person: opts.person,
        owner: opts.owner,
        limit: opts.limit,
    })));
    addOwnerOption(c
        .command("by-entity-date")
        .requiredOption("--entity-type <type>")
        .requiredOption("--from <iso>")
        .requiredOption("--to <iso>"))
        .option("--limit <n>", "", cappedInt(2000), 200)
        .action(jsonAction(getClient, (client, opts) => runLogByEntityDate(client, {
        entityType: opts.entityType,
        from: resolveDate(opts.from) ?? opts.from,
        to: resolveDate(opts.to) ?? opts.to,
        owner: opts.owner,
        limit: opts.limit,
    })));
    addOwnerOption(c.command("user [personId]"))
        .option("--limit <n>", "", cappedInt(500), 100)
        .action(jsonAction(getClient, (client, personIdStr, opts) => runLogUser(client, parseOptionalId(personIdStr, "personId") ?? null, opts.limit, { owner: opts.owner })));
    c.command("types")
        .action(guarded(() => {
        writeJson(runLogTypes());
    }));
}
//# sourceMappingURL=index.js.map