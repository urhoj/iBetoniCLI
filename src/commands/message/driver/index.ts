import { Option, type Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../../api/writeFlags.js";
import { resolveActiveOwnerAsiakasId } from "../../../owner.js";
import { assertEnum, intFlag } from "../../../targets.js";
import { jsonAction } from "../../_shared/action.js";
import { applyFromJson } from "../../_shared/fromJson.js";
import { requireFlags } from "../../_shared/jsonBody.js";

const CHANNELS = ["push", "email"] as const;

type DriverSendOptions = WriteFlags & {
  person: number;
  channel: "push" | "email";
  message: string;
  subject?: string;
};

export async function runDriverSend(client: ApiClient, opts: DriverSendOptions): Promise<unknown> {
  return client.post(
    "/api/sms/message",
    {
      personId: opts.person,
      channel: opts.channel,
      message: opts.message,
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    },
    { headers: writeFlagsToHeaders(opts) }
  );
}

export async function runDriverChannels(client: ApiClient, opts: { person: number }): Promise<unknown> {
  const owner = await resolveActiveOwnerAsiakasId(client);
  return client.get(`/api/sms/channels/${opts.person}/${owner}`);
}

export function registerMessageDriverCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  const driver = parent.command("driver").description("Manual push/email to a driver of the active company");
  driver.command("channels")
    .requiredOption("--person <id>", "", intFlag("--person", 1))
    .action(jsonAction(getClient, runDriverChannels));

  const send = driver.command("send")
    .option("--person <id>", "", intFlag("--person", 1))
    .addOption(new Option("--channel <channel>").choices(CHANNELS))
    .option("--message <text>")
    .option("--subject <text>")
    .option("--from-json <file|->");
  addWriteFlagsToCommand(send).action(jsonAction(getClient, (client, opts: DriverSendOptions & { fromJson?: string }, cmd: Command) => {
    const input = { ...opts };
    applyFromJson(cmd, input, {
      nonPayload: new Set(["fromJson", "dryRun", "idempotencyKey", "reason", "help"]),
      numericFields: new Set(["person"]),
    });
    requireFlags(cmd, input, ["person", "channel", "message"]);
    input.person = intFlag("--person", 1)(String(input.person));
    assertEnum(input.channel, CHANNELS, "--channel");
    return runDriverSend(client, input);
  }));
}
