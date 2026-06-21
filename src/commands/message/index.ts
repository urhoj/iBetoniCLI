import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { registerMessageChatCommands } from "./chat/index.js";
import { registerMessageDailyCommands } from "./daily/index.js";
import { registerMessageBoardCommands } from "./board/index.js";
import { registerMessageSupportCommands } from "./support/index.js";
import { registerMessageThreadCommands } from "./thread/index.js";

/**
 * Register the `ib message` umbrella — communication systems grouped for
 * discovery (see spec §3). Four coherent sibling sub-groups, sharing only the
 * word "message" (separate tables/routes/mental models):
 *   - `chat`    — conversational person-to-person threads
 *   - `daily`   — grid daily-message boxes (date-keyed shared whiteboard)
 *   - `board` (alias `ilmoitustaulu`) — the company announcement board
 *   - `support` — Operator → platform support escalations (thread lifecycle)
 *
 * Each owns its own `message/<system>/` directory, co-located specs, and
 * glossary entry, and plugs in here as one `registerMessage<System>Commands(m,
 * getClient)` call. Do not flatten their verbs into this file.
 */
export function registerMessageCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const m = parent
    .command("message")
    .description(
      "Messaging: conversational chat threads, daily grid notes, the announcement board (ilmoitustaulu), and support escalations"
    );
  registerMessageChatCommands(m, getClient);
  registerMessageDailyCommands(m, getClient);
  registerMessageBoardCommands(m, getClient);
  registerMessageSupportCommands(m, getClient);
  registerMessageThreadCommands(m, getClient);
}
