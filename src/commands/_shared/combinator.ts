import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";

/**
 * One likely-duplicate entity pair from a combinator's /duplicates endpoint.
 * The shape is identical across the asiakas / person / tyomaa combinators
 * (all built from the shared `createCombinatorRouter` factory); only the
 * `matchCode` vocabulary and `confidence` levels differ per entity:
 *   - asiakas: matchCode ytunnus|exact_name|email|name_prefix · confidence high|low
 *   - person:  matchCode phone|email|full_name              · confidence high|medium
 *   - tyomaa:  matchCode tyomaa_strict|tyomaa_anonymous     · confidence high|medium
 * (kept as plain `string` so one type serves all three.)
 */
export interface DuplicatePair {
  id1: number;
  name1: string | null;
  id2: number;
  name2: string | null;
  matchCode: string;
  matchValue: string | null;
  confidence: string;
}

/** The two request-body id fields for a given combinator (e.g. mainPersonId/secondaryPersonId). */
export interface CombinatorIdFields {
  mainField: string;
  secondaryField: string;
}

/** Typed inputs for a combinator merge, entity-agnostic. */
export interface CombinatorMergeOptions {
  mainId: number;
  secondaryId: number;
  ownerAsiakasId: number;
  /** asiakas-combinator only (system-admin): permit a merge above the safety row cap. */
  allowBigMerge?: boolean;
}

/**
 * GET /api/admin/<base>/duplicates?ownerAsiakasId=<id> — likely-duplicate pairs
 * for one tenant. Admin gated server-side. The backend returns `{ pairs }` (top
 * 100, each pair once with id1 < id2); projected into the list envelope.
 * `truncated` is set when the 100-pair cap was hit (there is no cursor).
 */
export async function runCombinatorDuplicates(
  client: ApiClient,
  base: string,
  ownerAsiakasId: number
): Promise<ListEnvelope<DuplicatePair>> {
  const res = await client.get<{ pairs?: DuplicatePair[] }>(
    `/api/admin/${base}/duplicates?ownerAsiakasId=${ownerAsiakasId}`
  );
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
export async function runCombinatorMerge(
  client: ApiClient,
  base: string,
  idFields: CombinatorIdFields,
  opts: CombinatorMergeOptions,
  flags: WriteFlags
): Promise<unknown> {
  const body: Record<string, unknown> = {
    [idFields.mainField]: opts.mainId,
    [idFields.secondaryField]: opts.secondaryId,
    ownerAsiakasId: opts.ownerAsiakasId,
  };
  if (opts.allowBigMerge) body.allowBigMerge = true;
  if (flags.dryRun) {
    // /validate is a tenant-scoped READ that happens to use POST — mark it `read`
    // so the --read-only / IB_READ_ONLY write-lock and the acting-as "write"
    // diagnostic both skip it (it never mutates).
    const validation = await client.post<unknown>(`/api/admin/${base}/validate`, body, {
      read: true,
    });
    return { dryRun: true, validation };
  }
  return client.post<unknown>(`/api/admin/${base}/merge`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}
