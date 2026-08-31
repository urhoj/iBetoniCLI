import { createStore, defaultCredentialsPath, endpointKey } from "./store.js";
/**
 * fb#1040: the "Not logged in" failure, endpoint-aware. The message+hint used
 * to exist only on the `clientFrom` path (program.ts); commands that touch the
 * credential store DIRECTLY (`auth whoami`, `auth refresh`) emitted the generic
 * form whose remedy drops the endpoint — following `ib auth login` verbatim
 * then authenticates against the DEFAULT endpoint while the requested one
 * stays unauthenticated. Both shapes now come from here.
 *
 * `mentionIbToken`: `auth whoami` also resolves IB_TOKEN (env sessions), so its
 * remedy names it; file-store-only paths (refresh) do not.
 */
export function notLoggedInMessage(endpoint, opts) {
    const suffix = opts?.mentionIbToken ? " (or set IB_TOKEN)" : "";
    return `Not logged in${endpoint ? ` at ${endpoint}` : ""}. Run \`ib auth login${endpoint ? ` --endpoint ${endpoint}` : ""}\` first${suffix}.`;
}
// fb#855: sessions are per endpoint. Under --endpoint, name the sessions that
// DO exist so the fix reads as one login, not "re-login everywhere".
export async function otherSessionsHint(endpoint) {
    if (!endpoint)
        return undefined;
    let hosts = [];
    try {
        hosts = (await createStore(defaultCredentialsPath()).sessions()).map((s) => endpointKey(s.endpoint));
    }
    catch {
        // a corrupt credentials file reads as "no sessions" — the message above already says what to do
    }
    return hosts.length
        ? `sessions are kept per endpoint — you hold ${hosts.join(", ")}, which stay; \`ib auth login --endpoint ${endpoint}\` adds this one`
        : undefined;
}
//# sourceMappingURL=notLoggedIn.js.map