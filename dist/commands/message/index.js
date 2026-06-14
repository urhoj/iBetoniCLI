import { registerMessageChatCommands } from "./chat/index.js";
/**
 * Register the `ib message` umbrella — communication systems grouped for
 * discovery (see spec §3). Conversational `chat` is built here.
 *
 * EXTENSION POINT (concurrent work): the announcement board (`ib message board`
 * / `ilmoitustaulu`) and the grid daily-box system (`ib message daily`) are
 * reserved sibling sub-groups. They plug in here as additional
 * `registerMessage<System>Commands(m, getClient)` calls — each owns its own
 * `message/<system>/` directory, specs, and glossary entry. Do not flatten
 * their verbs into this file.
 */
export function registerMessageCommands(parent, getClient) {
    const m = parent
        .command("message")
        .description("Messaging: conversational chat threads (daily notes + announcements are reserved sub-groups)");
    registerMessageChatCommands(m, getClient);
}
//# sourceMappingURL=index.js.map