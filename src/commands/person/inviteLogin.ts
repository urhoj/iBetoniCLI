import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";
import { assertEnum, intFlag, resolvePersonTarget } from "../../targets.js";
import { jsonAction } from "../_shared/action.js";

export const INVITE_CHANNELS = ["sms", "email"] as const;

type InviteOpts = WriteFlags & { channel?: string; orders?: boolean; message?: string; force?: boolean };

/**
 * POST /api/sms/invite-login (fb#2959): one login invite, SMS or email by the server's channel rule.
 * --dry-run is honoured server-side (X-Dry-Run): it picks the channel and builds the text, sends nothing.
 */
export async function runInviteLogin(client: ApiClient, personId: number, opts: InviteOpts): Promise<unknown> {
  return client.post(
    "/api/sms/invite-login",
    { personId, channel: opts.channel, orders: opts.orders !== false, message: opts.message, force: opts.force === true },
    { headers: writeFlagsToHeaders(opts) }
  );
}

/** Register `ib person invite-login [personId]`. Spec: src/reference/specs/person.ts. */
export function registerPersonInviteLoginCommand(parent: Command, getClient: () => Promise<ApiClient>): void {
  addWriteFlagsToCommand(
    parent
      .command("invite-login [personId]")
      .description("Send one person a login invite (SMS, else email)")
      .option("--person <id>", "", intFlag("--person", 1))
      .option("--channel <channel>")
      .option("--no-orders")
      .option("--message <text>")
      .option("--force")
  ).action(jsonAction(getClient, (client, idStr: string | undefined, opts: InviteOpts & { person?: number }) => {
    const personId = resolvePersonTarget(idStr, opts.person);
    assertEnum(opts.channel, INVITE_CHANNELS, "--channel");
    return runInviteLogin(client, personId, opts);
  }));
}
