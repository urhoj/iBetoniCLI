import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import {
  addWriteFlagsToCommand,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { guarded } from "./action.js";
import { intFlag } from "../../targets.js";

/**
 * The POST body both person-link routes take: the target entity's id first,
 * then the person and the link type. Key order matters — it is the serialized
 * request body.
 */
export type PersonLinkBody = Record<string, number>;

/**
 * Everything that differs between the customer (`asiakasPerson`) and worksite
 * (`tyomaaPerson`) link registrations — and nothing else. Both attach/detach a
 * person to an entity with the same `--person` flag, the same `--contact-type`
 * default, the same mandatory `--reason`, and the same three-field body; only
 * the target flag, the body's id field, and the two route paths vary.
 */
/** Parsed options of an `add`/`remove` leaf; the target id is keyed by `cfg.targetFlag`. */
type PersonLinkOptions = WriteFlags & {
  person: number;
  contactType: number;
} & Record<string, unknown>;

export interface PersonLinkCommandsConfig {
  /** Target flag name without the `--` prefix, e.g. `asiakas` / `worksite`. */
  targetFlag: string;
  /** Description of the target flag, e.g. "Target asiakasId". */
  targetDescription: string;
  /** Body field carrying the target id, e.g. `asiakasId` / `tyomaaId`. */
  targetField: string;
  /** Description of `--contact-type` (the customer form documents the type ids). */
  contactTypeDescription: string;
  add: (client: ApiClient, body: PersonLinkBody, flags: WriteFlags) => Promise<unknown>;
  remove: (client: ApiClient, body: PersonLinkBody, flags: WriteFlags) => Promise<unknown>;
}

/**
 * Register the `add` + `remove` leaves of one entity↔person link group.
 *
 * Both are lifecycle writes, so `--reason` is mandatory (no `--dry-run`
 * exemption) — the link change lands in changeTracker and an unexplained
 * membership edit is exactly what the audit trail exists to catch. The
 * requirement is spec-declared (`reasonPolicy: "always"` on all four
 * person-link specs) and enforced centrally by the preAction hook.
 */
export function registerPersonLinkCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  cfg: PersonLinkCommandsConfig
): void {
  const register = (
    name: "add" | "remove",
    run: (client: ApiClient, body: PersonLinkBody, flags: WriteFlags) => Promise<unknown>
  ): void => {
    addWriteFlagsToCommand(
      parent
        .command(name)
        .requiredOption(`--${cfg.targetFlag} <id>`, cfg.targetDescription, intFlag(`--${cfg.targetFlag}`, 1))
        .requiredOption("--person <id>", "", intFlag("--person", 1))
        .option("--contact-type <id>", cfg.contactTypeDescription, intFlag("--contact-type", 1), 1)
    ).action(
      guarded(async (opts: PersonLinkOptions) => {
        const client = await getClient();
        writeJson(
          await run(
            client,
            {
              [cfg.targetField]: opts[cfg.targetFlag] as number,
              personId: opts.person,
              contactPersonTypeId: opts.contactType,
            },
            opts
          )
        );
      })
    );
  };

  register("add", cfg.add);
  register("remove", cfg.remove);
}
