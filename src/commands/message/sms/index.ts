import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../../api/writeFlags.js";
import { resolveActiveOwnerAsiakasId } from "../../../owner.js";
import { intFlag } from "../../../targets.js";
import { jsonAction } from "../../_shared/action.js";

// --dry-run is honoured SERVER-side (POST /api/sms/send reads X-Dry-Run): the server
// validates the text and resolves the tenant-scoped recipient, then returns without
// sending or logging. Owner ruling 2026-10-12: user-initiated only, HAS_SMS + admin.

export async function runSmsSend(
  client: ApiClient,
  opts: WriteFlags & { person: number; message: string }
): Promise<unknown> {
  return client.post(
    "/api/sms/send",
    { personId: opts.person, message: opts.message },
    { headers: writeFlagsToHeaders(opts) }
  );
}

export async function runSmsList(client: ApiClient, opts: { person: number; owner: number }): Promise<unknown> {
  return client.get(`/api/sms/person/${opts.person}/${opts.owner}`);
}

/**
 * Register `ib message sms` — manual driver SMS (HAS_SMS tenants, admins):
 *   send --person <id> --message <text>   send one SMS (≤ 2 segments, no links)
 *   list --person <id>                    SMS sent to that person, newest first
 */
export function registerMessageSmsCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  const s = parent.command("sms").description("Manual SMS to a driver of the active company (HAS_SMS module, admins)");

  const sendCmd = s
    .command("send")
    .requiredOption("--person <id>", "", intFlag("--person", 1))
    .requiredOption("--message <text>");
  addWriteFlagsToCommand(sendCmd).action(
    jsonAction(getClient, (client, opts: WriteFlags & { person: number; message: string }) => runSmsSend(client, opts))
  );

  s.command("list")
    .requiredOption("--person <id>", "", intFlag("--person", 1))
    .action(
      jsonAction(getClient, async (client, opts: { person: number }) =>
        runSmsList(client, { person: opts.person, owner: await resolveActiveOwnerAsiakasId(client) })
      )
    );
}
