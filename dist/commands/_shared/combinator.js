import { listEnvelope } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { guarded } from "./action.js";
import { addOwnerOption } from "../../targets.js";
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
        const validation = await client.post(`/api/admin/${base}/validate`, body, {
            read: true,
        });
        return { dryRun: true, validation };
    }
    return client.post(`/api/admin/${base}/merge`, body, {
        headers: writeFlagsToHeaders(flags),
    });
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
    parent
        .command("duplicates")
        .option("--owner <id>", "", Number)
        .action(guarded(async (opts) => {
        const client = await getClient();
        const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
        writeJson(await runCombinatorDuplicates(client, cfg.base, owner));
    }));
    const mergeCmd = addOwnerOption(parent
        .command("merge")
        .requiredOption("--main <id>", "", Number)
        .requiredOption("--secondary <id>", "", Number));
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
        const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
        writeJson(await runCombinatorMerge(client, cfg.base, cfg.idFields, {
            mainId: opts.main,
            secondaryId: opts.secondary,
            ownerAsiakasId: owner,
            allowBigMerge: opts.allowBigMerge,
        }, opts));
    }));
}
//# sourceMappingURL=combinator.js.map