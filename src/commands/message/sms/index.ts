import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../../api/writeFlags.js";
import { resolveActiveOwnerAsiakasId } from "../../../owner.js";
import { intFlag } from "../../../targets.js";
import { resolveDate } from "../../../dates.js";
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

/** GET /api/sms/log (fb#2534): the active company's whole message log + SMS cost estimate, as a list envelope. */
export async function runSmsLog(
  client: ApiClient,
  opts: { owner: number; from?: string; to?: string; channel?: string }
): Promise<unknown> {
  const q = new URLSearchParams();
  const from = resolveDate(opts.from);
  const to = resolveDate(opts.to);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (opts.channel) q.set("channel", opts.channel);
  const qs = q.toString();
  // The server caps at 500 rows and says whether more matched (no cursor).
  const r = await client.get<{ items?: unknown[]; truncated?: boolean; totals?: unknown }>(`/api/sms/log/${opts.owner}${qs ? `?${qs}` : ""}`);
  const items = r?.items ?? [];
  return { items, nextCursor: null, count: items.length, truncated: r?.truncated === true, totals: r?.totals ?? null };
}

/**
 * Register `ib message sms` — manual driver SMS (HAS_SMS tenants, admins):
 *   send --person <id> --message <text>   send one SMS (≤ 2 segments, no links)
 *   list --person <id>                    SMS sent to that person, newest first
 *   log [--from] [--to] [--channel]       every message of the company + SMS cost estimate
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

  s.command("log")
    .option("--from <date>")
    .option("--to <date>")
    .option("--channel <channel>")
    .action(
      jsonAction(getClient, async (client, opts: { from?: string; to?: string; channel?: string }) =>
        runSmsLog(client, { ...opts, owner: await resolveActiveOwnerAsiakasId(client) })
      )
    );
}
