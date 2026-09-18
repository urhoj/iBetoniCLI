import { listEnvelope } from "../../api/envelopes.js";
import { CliError } from "../../api/errors.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { guarded } from "./action.js";
import { addOwnerOption } from "../../targets.js";
/**
 * Pulls `error.conflictingFields` out of a combinator validate 400's parsed
 * body, if present, non-empty, and every element is a well-formed
 * {field, mainValue, secondaryValue} object (fb#1840) — a malformed entry
 * (null, a bare string/number) is treated as absent so the caller falls back
 * to the plain error instead of formatConflictingFields crashing on it.
 */
function extractConflictingFields(body) {
    if (!body || typeof body !== "object")
        return null;
    const err = body.error;
    if (!err || typeof err !== "object")
        return null;
    const fields = err.conflictingFields;
    if (!Array.isArray(fields) || fields.length === 0)
        return null;
    const wellFormed = fields.every((f) => f && typeof f === "object" && typeof f.field === "string");
    return wellFormed ? fields : null;
}
function formatConflictingFields(fields) {
    return fields
        .map((f) => `${f.field} ('${String(f.mainValue)}' vs '${String(f.secondaryValue)}')`)
        .join(", ");
}
/**
 * GET /api/admin/<base>/duplicates?ownerAsiakasId=<id> — likely-duplicate pairs
 * for one tenant. Admin gated server-side. The backend returns `{ pairs }` (top
 * 100, each pair once with id1 < id2); projected into the list envelope.
 * `truncated` is set when the 100-pair cap was hit (there is no cursor).
 */
export async function runCombinatorDuplicates(client, base, ownerAsiakasId) {
    const res = await client.get(`/api/admin/${base}/duplicates?ownerAsiakasId=${ownerAsiakasId}`);
    const items = Array.isArray(res?.pairs) ? res.pairs : [];
    return listEnvelope(items, { truncated: items.length >= 100 });
}
/**
 * Merge two duplicate entities — the secondary's references move onto the main,
 * then the secondary is deleted. IRREVERSIBLE, admin gated server-side.
 *
 * `--dry-run` calls POST /validate (the read-only safety check reporting what
 * WOULD move + any blocking conflicts) and NEVER merges — the /merge route has
 * no `X-Dry-Run` guard, so a server-side dry-run there would still merge. The
 * validate call is tagged `read`, so `merge --dry-run` runs even under
 * `--read-only` / `IB_READ_ONLY`. The real path POSTs /merge with the universal
 * write-flag headers.
 */
export async function runCombinatorMerge(client, base, idFields, opts, flags) {
    const body = {
        [idFields.mainField]: opts.mainId,
        [idFields.secondaryField]: opts.secondaryId,
        ownerAsiakasId: opts.ownerAsiakasId,
    };
    if (opts.allowBigMerge)
        body.allowBigMerge = true;
    if (flags.dryRun) {
        // /validate is a tenant-scoped READ that happens to use POST — mark it `read`
        // so the --read-only / IB_READ_ONLY write-lock and the acting-as "write"
        // diagnostic both skip it (it never mutates).
        try {
            const validation = await client.post(`/api/admin/${base}/validate`, body, {
                read: true,
            });
            return { dryRun: true, validation };
        }
        catch (err) {
            // fb#1822: a field conflict (validationStatus ERROR) answers 400 with the
            // Finnish message AND error.conflictingFields [{field, mainValue,
            // secondaryValue}] — the caller's actual remedy — but that detail was
            // visible only under --verbose. Fold it into the compact error. Also
            // drops the generic "run --dry-run first" hint on a plain 400 HERE,
            // since this call IS the dry run.
            //
            // fb#1839: narrowed to statusCode === 400 ONLY — a 401/403/404/5xx/network
            // CliError from this same POST must keep its own spec-driven hint (e.g.
            // "ib auth refresh" on 401), not get overwritten. And the new hint text
            // is set only for tyomaa-combinator, where it's actually correct; for
            // person/customer the hint is left UNSET so hintDetailForError falls
            // through to that entity's own curated spec row (e.g. person.ts's
            // errorNumber-50203 day-vehicle-conflict remedy, which names a completely
            // different fix than "align fields onto the secondary").
            if (err instanceof CliError && err.statusCode === 400) {
                const conflicts = extractConflictingFields(err.body);
                if (conflicts) {
                    throw new CliError(`${err.message} — conflicting field(s): ${formatConflictingFields(conflicts)}`, err.statusCode, err.body, err.exitCode, base === "tyomaa-combinator"
                        ? "align the conflicting field(s) onto the secondary, e.g. `ib worksite update <secondaryId> --name/--address/--address2/--postal-code/--city`, then re-run --dry-run"
                        : undefined);
                }
                throw new CliError(err.message, err.statusCode, err.body, err.exitCode, "check --main/--secondary");
            }
            throw err;
        }
    }
    return client.post(`/api/admin/${base}/merge`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Resolve the effective ownerAsiakasId for a combinator call: `--unowned` → 0
 * (the unowned class), else `--owner`, else the active company. The two flags
 * are mutually exclusive — silently preferring one would target the wrong
 * tenant on an IRREVERSIBLE operation.
 */
export async function resolveCombinatorOwner(client, opts) {
    if (opts.unowned && opts.owner !== undefined) {
        failWith("--unowned and --owner are mutually exclusive", 4);
    }
    if (opts.unowned)
        return 0;
    return opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
}
/**
 * Register the `duplicates` + `merge` leaves of one combinator on its group.
 *
 * `merge` is IRREVERSIBLE, so both id guards run before any network call
 * (positive integers, distinct ids). The third guard — `--reason` mandatory
 * unless `--dry-run` (which routes to the read-only /validate preview instead)
 * — is spec-declared (`reasonPolicy: "unless-dry-run"` on each entity's merge
 * spec) and enforced centrally by the preAction hook.
 */
export function registerCombinatorCommands(parent, getClient, cfg) {
    // addOwnerOption, not a bare `Number` (matching merge below): NaN is not
    // nullish, so a bare-Number `--owner abc` survived the `??` default and
    // reached the wire as ?ownerAsiakasId=NaN — and `--owner 0` was an
    // undocumented spelling of the unowned class on all three combinators,
    // which --unowned exists to gate. intFlag rejects both client-side.
    const duplicatesCmd = addOwnerOption(parent.command("duplicates"));
    if (cfg.unownedClass) {
        duplicatesCmd.option("--unowned");
    }
    duplicatesCmd.action(guarded(async (opts) => {
        const client = await getClient();
        const owner = await resolveCombinatorOwner(client, opts);
        writeJson(await runCombinatorDuplicates(client, cfg.base, owner));
    }));
    const mergeCmd = addOwnerOption(parent
        .command("merge")
        .requiredOption("--main <id>", "", Number)
        .requiredOption("--secondary <id>", "", Number));
    if (cfg.unownedClass) {
        mergeCmd.option("--unowned");
    }
    if (cfg.allowBigMerge) {
        mergeCmd.option("--allow-big-merge");
    }
    addWriteFlagsToCommand(mergeCmd).action(guarded(async (opts) => {
        if (!Number.isInteger(opts.main) || opts.main <= 0 ||
            !Number.isInteger(opts.secondary) || opts.secondary <= 0) {
            failWith(`--main and --secondary must be positive integer ${cfg.idLabel}s`, 4);
        }
        if (opts.main === opts.secondary) {
            failWith("--main and --secondary must differ", 4);
        }
        const client = await getClient();
        const owner = await resolveCombinatorOwner(client, opts);
        writeJson(await runCombinatorMerge(client, cfg.base, cfg.idFields, {
            mainId: opts.main,
            secondaryId: opts.secondary,
            ownerAsiakasId: owner,
            allowBigMerge: opts.allowBigMerge,
        }, opts));
    }));
}
//# sourceMappingURL=combinator.js.map