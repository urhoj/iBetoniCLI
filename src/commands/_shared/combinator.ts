import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { guarded } from "./action.js";
import { addOwnerOption } from "../../targets.js";

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

/**
 * Everything that differs between the asiakas / person / tyomaa `duplicates` +
 * `merge` registrations — and nothing else. The three copies were otherwise
 * verbatim: same flag names, same owner fallback, same three guards in the same
 * order; only the entity wording and customer's `--allow-big-merge` varied.
 */
export interface CombinatorCommandsConfig {
  /** Route segment, e.g. `asiakas-combinator`. */
  base: string;
  /** Request-body id field names for /merge + /validate. */
  idFields: CombinatorIdFields;
  /** Entity word in the "<noun> merge is irreversible" guard (customer/person/worksite). */
  entityNoun: string;
  /** Id word in the flag descriptions and the positive-integer guard, pluralized with a bare "s". */
  idLabel: string;
  /** asiakas combinator only: expose the system-admin `--allow-big-merge` escape hatch. */
  allowBigMerge?: boolean;
  /**
   * person combinator only (fb#849): expose `--unowned`, which addresses the
   * UNOWNED class — rows whose ownerAsiakasId is 0 OR NULL (self-registrations,
   * imports, pre-ownership rows: the population that actually accumulates
   * duplicates). Sent as ownerAsiakasId 0; the backend accepts it only for
   * entities whose validator supports the class, and only from a system admin.
   */
  unownedClass?: boolean;
}

/**
 * Resolve the effective ownerAsiakasId for a combinator call: `--unowned` → 0
 * (the unowned class), else `--owner`, else the active company. The two flags
 * are mutually exclusive — silently preferring one would target the wrong
 * tenant on an IRREVERSIBLE operation.
 */
export async function resolveCombinatorOwner(
  client: ApiClient,
  opts: { owner?: number; unowned?: boolean }
): Promise<number> {
  if (opts.unowned && opts.owner !== undefined) {
    failWith("--unowned and --owner are mutually exclusive", 4);
  }
  if (opts.unowned) return 0;
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
export function registerCombinatorCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  cfg: CombinatorCommandsConfig
): void {
  const duplicatesCmd = parent.command("duplicates").option("--owner <id>", "", Number);
  if (cfg.unownedClass) duplicatesCmd.option("--unowned");
  duplicatesCmd.action(
    guarded(async (opts: { owner?: number; unowned?: boolean }) => {
      const client = await getClient();
      const owner = await resolveCombinatorOwner(client, opts);
      writeJson(await runCombinatorDuplicates(client, cfg.base, owner));
    })
  );

  const mergeCmd = addOwnerOption(
    parent
      .command("merge")
      .requiredOption("--main <id>", "", Number)
      .requiredOption(
        "--secondary <id>",
        "",
        Number
      )
  );
  if (cfg.unownedClass) {
    mergeCmd.option("--unowned");
  }
  if (cfg.allowBigMerge) {
    mergeCmd.option("--allow-big-merge");
  }
  addWriteFlagsToCommand(mergeCmd).action(
    guarded(async (
      opts: WriteFlags & {
        main: number;
        secondary: number;
        owner?: number;
        unowned?: boolean;
        allowBigMerge?: boolean;
      }
    ) => {
      if (
        !Number.isInteger(opts.main) || opts.main <= 0 ||
        !Number.isInteger(opts.secondary) || opts.secondary <= 0
      ) {
        failWith(`--main and --secondary must be positive integer ${cfg.idLabel}s`, 4);
      }
      if (opts.main === opts.secondary) {
        failWith("--main and --secondary must differ", 4);
      }
      const client = await getClient();
      const owner = await resolveCombinatorOwner(client, opts);
      writeJson(
        await runCombinatorMerge(
          client,
          cfg.base,
          cfg.idFields,
          {
            mainId: opts.main,
            secondaryId: opts.secondary,
            ownerAsiakasId: owner,
            allowBigMerge: opts.allowBigMerge,
          },
          opts
        )
      );
    })
  );
}
