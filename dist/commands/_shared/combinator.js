import { writeFlagsToHeaders } from "../../api/writeFlags.js";
/**
 * GET /api/admin/<base>/duplicates?ownerAsiakasId=<id> — likely-duplicate pairs
 * for one tenant. Admin gated server-side. The backend returns `{ pairs }` (top
 * 100, each pair once with id1 < id2); projected into the list envelope.
 * `truncated` is set when the 100-pair cap was hit (there is no cursor).
 */
export async function runCombinatorDuplicates(client, base, ownerAsiakasId) {
    const res = await client.get(`/api/admin/${base}/duplicates?ownerAsiakasId=${ownerAsiakasId}`);
    const items = Array.isArray(res?.pairs) ? res.pairs : [];
    return { items, nextCursor: null, count: items.length, truncated: items.length >= 100 };
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
//# sourceMappingURL=combinator.js.map