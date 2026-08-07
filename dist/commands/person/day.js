import { listEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith } from "../../output/json.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { resolveDate } from "../../dates.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { qs } from "../../api/query.js";
import { bothInOrder } from "../../parallel.js";
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
    const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
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
    return listEnvelope(items);
}
/** GET /api/personPvm/list/:asiakasId — a person's day rows over [from, to] (to defaults to from). */
export async function runPersonDayGet(client, personId, from, to) {
    const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
    const startDate = resolveDate(from) ?? from;
    const endDate = resolveDate(to ?? from) ?? (to ?? from);
    const rows = await client.get(`/api/personPvm/list/${asiakasId}${qs({ startDate, endDate, personId })}`);
    const items = (rows || []).map((r) => ({
        personPvmId: Number(r.personPvmId),
        date: intToDate(Number(r.pvm)),
        statusId: r.personPvmStatusId != null ? Number(r.personPvmStatusId) : null,
        status: r.personPvmStatus ?? null,
        pois: !!r.pois,
        vehicleId: r.vehicleId != null ? Number(r.vehicleId) : null,
        text: r.personPvmText ?? null,
    }));
    return listEnvelope(items);
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
        failWith(`No status matches "${value}". Available: ${candidates}`, 4);
    }
    failWith(`Status "${value}" is ambiguous — use the id. Available: ${candidates}`, 4);
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
    const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
    const pvm = toYyyymmdd(date);
    // The status lookup (only issued for a non-numeric --status) is keyed on the
    // status name; the day read on person+date. Independent, so run them together —
    // ordered so a bad --status still reports the validation error, not whichever
    // of the two failed first.
    const [statusId, existing] = await bothInOrder(resolveStatusId(client, statusValue), runPersonDayGet(client, personId, date, date));
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
    const asiakasId = ownerAsiakasIdFromToken(client, "run `ib auth switch`");
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
        .option("--full")
        .action(jsonAction(getClient, (client, opts) => runPersonDayStatuses(client, { full: opts.full })));
    day
        .command("get")
        .requiredOption("--person <id>", "", (s) => Number(s))
        .requiredOption("--from <date>")
        .option("--to <date>")
        .action(jsonAction(getClient, (client, opts) => runPersonDayGet(client, opts.person, opts.from, opts.to)));
    const setCmd = day
        .command("set")
        .requiredOption("--person <id>", "", (s) => Number(s))
        .requiredOption("--date <date>")
        .requiredOption("--status <id|name>")
        .option("--text <s>");
    addWriteFlagsToCommand(setCmd).action(guarded(async (opts) => {
        const result = await runPersonDaySet(await getClient(), opts.person, opts.date, opts.status, opts);
        writeJson(result);
    }));
    const clearCmd = day
        .command("clear")
        .requiredOption("--person <id>", "", (s) => Number(s))
        .requiredOption("--date <date>");
    addWriteFlagsToCommand(clearCmd).action(guarded(async (opts) => {
        const result = await runPersonDayClear(await getClient(), opts.person, opts.date, opts);
        writeJson(result);
    }));
}
//# sourceMappingURL=day.js.map