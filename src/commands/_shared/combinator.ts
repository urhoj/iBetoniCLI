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
}

/**
 * Register the `duplicates` + `merge` leaves of one combinator on its group.
 *
 * `merge` is IRREVERSIBLE, so it keeps all three guards before any network call:
 * both ids positive integers, the two ids distinct, and `--reason` mandatory
 * unless `--dry-run` (which routes to the read-only /validate preview instead).
 */
export function registerCombinatorCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  cfg: CombinatorCommandsConfig
): void {
  parent
    .command("duplicates")
    .option("--owner <id>", "ownerAsiakasId to scan (default: active company)", Number)
    .action(
      guarded(async (opts: { owner?: number }) => {
        const client = await getClient();
        const owner =
          opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
        writeJson(await runCombinatorDuplicates(client, cfg.base, owner));
      })
    );

  const mergeCmd = addOwnerOption(
    parent
      .command("merge")
      .requiredOption("--main <id>", `${cfg.idLabel} to KEEP (references merge into this)`, Number)
      .requiredOption(
        "--secondary <id>",
        `${cfg.idLabel} to REMOVE (merged away, then deleted)`,
        Number
      )
  );
  if (cfg.allowBigMerge) {
    mergeCmd.option("--allow-big-merge", "System-admin: permit a merge above the safety row cap");
  }
  addWriteFlagsToCommand(mergeCmd).action(
    guarded(async (
      opts: WriteFlags & {
        main: number;
        secondary: number;
        owner?: number;
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
      if (!opts.dryRun && !opts.reason) {
        failWith(
          `${cfg.entityNoun} merge is irreversible — pass --reason (or --dry-run to preview via /validate)`,
          4
        );
      }
      const client = await getClient();
      const owner =
        opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
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
