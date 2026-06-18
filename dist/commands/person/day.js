import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { resolveDate } from "../../dates.js";
import { CliError } from "../../api/errors.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
/** Active company id (personPvm `:asiakasId`) from the JWT — same pattern as `vehicle create`. */
function ownerAsiakasIdOf(client) {
    const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken());
    if (typeof ownerAsiakasId !== "number" || ownerAsiakasId <= 0) {
        throw new Error("could not resolve active company from token — run `ib auth switch`");
    }
    return ownerAsiakasId;
}
/** 20260610 → "2026-06-10". */
function intToDate(n) {
    const s = String(n);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
/** date alias/ISO → integer yyyymmdd. */
function toYyyymmdd(date) {
    return Number(resolveDate(date).replace(/-/g, ""));
}
/** GET /api/personPvm/statusList/:asiakasId — the day-status types for the active company. */
export async function runPersonDayStatuses(client, opts = {}) {
    const asiakasId = ownerAsiakasIdOf(client);
    const rows = await client.get(`/api/personPvm/statusList/${asiakasId}`);
    const items = (rows || []).map((r) => {
        const base = {
            statusId: Number(r.personPvmStatusId),
            code: r.personPvmStatus ?? null,
            name: r.personPvmStatusName ?? null,
            pois: !!r.pois,
            vakioVapaa: !!r.vakioVapaa,
        };
        if (!opts.full)
            return base;
        return {
            ...base,
            description: r.personPvmStatusDescription ?? null,
            prefix: r.prefix ?? null,
            style: r.style ?? null,
            active: !!r.active,
            ownerAsiakasId: r.ownerAsiakasId != null ? Number(r.ownerAsiakasId) : null,
        };
    });
    return { items, nextCursor: null, count: items.length };
}
/** GET /api/personPvm/list/:asiakasId — a person's day rows over [from, to] (to defaults to from). */
export async function runPersonDayGet(client, personId, from, to) {
    const asiakasId = ownerAsiakasIdOf(client);
    const startDate = resolveDate(from) ?? from;
    const endDate = resolveDate(to ?? from) ?? (to ?? from);
    const params = new URLSearchParams({ startDate, endDate, personId: String(personId) });
    const rows = await client.get(`/api/personPvm/list/${asiakasId}?${params.toString()}`);
    const items = (rows || []).map((r) => ({
        personPvmId: Number(r.personPvmId),
        date: intToDate(Number(r.pvm)),
        statusId: r.personPvmStatusId != null ? Number(r.personPvmStatusId) : null,
        status: r.personPvmStatus ?? null,
        pois: !!r.pois,
        vehicleId: r.vehicleId != null ? Number(r.vehicleId) : null,
        text: r.personPvmText ?? null,
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * Resolve a `--status` value to a personPvmStatusId. All-digits → used as-is.
 * Otherwise fetch statusList once and match case-insensitively on code/name.
 * No / ambiguous match → CliError exit 4 listing the candidates.
 */
export async function resolveStatusId(client, value) {
    const v = value.trim();
    if (/^\d+$/.test(v))
        return Number(v);
    const { items } = await runPersonDayStatuses(client);
    const lc = v.toLowerCase();
    const matches = items.filter((s) => (s.code && s.code.toLowerCase() === lc) ||
        (s.name && s.name.toLowerCase() === lc));
    const candidates = items.map((s) => `${s.statusId}:${s.name ?? s.code}`).join(", ");
    if (matches.length === 1)
        return matches[0].statusId;
    if (matches.length === 0) {
        throw new CliError(`No status matches "${value}". Available: ${candidates}`, 400, null, 4);
    }
    throw new CliError(`Status "${value}" is ambiguous — use the id. Available: ${candidates}`, 400, null, 4);
}
/**
 * Set a person's day availability status. Read-merges the existing row for that
 * person+date (so a re-set UPDATES rather than inserting a duplicate via
 * personPvm_save2's null-id insert path). `--dry-run` is CLIENT-side (the save
 * endpoint has no X-Dry-Run guard) — it returns a wouldChange diff and never POSTs.
 * When --text is omitted the existing text is preserved (not wiped). The existing
 * vehicleId is ALWAYS threaded back — the proc's UPDATE branch sets vehicleId
 * unconditionally, so omitting it would null the day's driver and strip the
 * person from that day's pump keikkat.
 */
export async function runPersonDaySet(client, personId, date, statusValue, flags) {
    const asiakasId = ownerAsiakasIdOf(client);
    const pvm = toYyyymmdd(date);
    const statusId = await resolveStatusId(client, statusValue);
    const existing = await runPersonDayGet(client, personId, date, date);
    const current = existing.items[0];
    const curStatusId = current ? (current.statusId ?? null) : null;
    const curText = current ? (current.text ?? null) : null;
    const curVehicleId = current ? (current.vehicleId ?? null) : null;
    const nextText = flags.text ?? curText ?? null;
    if (flags.dryRun) {
        const wouldChange = {};
        if (curStatusId !== statusId)
            wouldChange.status = { from: curStatusId, to: statusId };
        if ((curText ?? null) !== (nextText ?? null))
            wouldChange.text = { from: curText ?? null, to: nextText ?? null };
        return { dryRun: true, personId, date: resolveDate(date), wouldChange };
    }
    const body = {
        personId,
        pvm,
        personPvmStatusId: statusId,
        personPvmText: nextText,
        vehicleId: curVehicleId,
    };
    if (current)
        body.personPvmId = current.personPvmId;
    return client.post(`/api/personPvm/save/${asiakasId}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Delete a person's personPvm row for a date (remove the status entry).
 * Resolves the personPvmId via the day list first. `--dry-run` is CLIENT-side
 * (returns wouldDelete, no DELETE). No row → a clean "nothing to delete" result.
 */
export async function runPersonDayClear(client, personId, date, flags) {
    const asiakasId = ownerAsiakasIdOf(client);
    const existing = await runPersonDayGet(client, personId, date, date);
    const current = existing.items[0];
    if (flags.dryRun) {
        return {
            dryRun: true,
            wouldDelete: current
                ? {
                    personPvmId: current.personPvmId,
                    date: intToDate(toYyyymmdd(date)),
                    status: current.status ?? null,
                }
                : null,
        };
    }
    if (!current) {
        return { deleted: false, message: "no personPvm row for that person/date" };
    }
    return client.delete(`/api/personPvm/delete/${asiakasId}/${current.personPvmId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Register `ib person day` on the existing `person` command.
 * Reads: statuses, get. Writes: set, clear (added in later tasks).
 */
export function registerPersonDayCommands(person, getClient) {
    const day = person
        .command("day")
        .description("Person-day availability (personPvm status) management");
    day
        .command("statuses")
        .description("List the day-status types (vacation/sick/free/…) for the active company")
        .option("--full", "Include prefix/style/description/active/ownerAsiakasId")
        .action(async (opts) => {
        try {
            writeJson(await runPersonDayStatuses(await getClient(), { full: opts.full }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    day
        .command("get")
        .description("List a person's day rows (status / vehicle / text) over a date range")
        .requiredOption("--person <id>", "personId", (s) => Number(s))
        .requiredOption("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
        .option("--to <date>", "End date YYYY-MM-DD (default: --from)")
        .action(async (opts) => {
        try {
            writeJson(await runPersonDayGet(await getClient(), opts.person, opts.from, opts.to));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const setCmd = day
        .command("set")
        .description("Set a person's day availability status (vacation/sick/free/…). Requires --reason.")
        .requiredOption("--person <id>", "personId", (s) => Number(s))
        .requiredOption("--date <date>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)")
        .requiredOption("--status <id|name>", "personPvmStatusId or status name (see `ib person day statuses`)")
        .option("--text <s>", "Free-text note on the day row");
    addWriteFlagsToCommand(setCmd).action(async (opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const result = await runPersonDaySet(await getClient(), opts.person, opts.date, opts.status, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
                text: opts.text,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const clearCmd = day
        .command("clear")
        .description("Delete a person's day row for a date (remove status entry). Requires --reason.")
        .requiredOption("--person <id>", "personId", (s) => Number(s))
        .requiredOption("--date <date>", "Day YYYY-MM-DD (or today/yesterday/tomorrow)");
    addWriteFlagsToCommand(clearCmd).action(async (opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const result = await runPersonDayClear(await getClient(), opts.person, opts.date, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=day.js.map