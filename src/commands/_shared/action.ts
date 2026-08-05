/**
 * The two Commander `.action()` tails every command group was hand-writing.
 *
 * The repo convention (see betonicli/CLAUDE.md "Command implementation pattern")
 * is: keep the network/transform logic in an exported pure `run*` function and
 * keep the action thin — resolve the client, call `run*`, `writeJson`, and route
 * any throw through `exitWithError`. That tail was copied into ~300 actions, so
 * the convention was enforced only by discipline: an action that forgets the
 * catch escapes to `handleParseRejection`'s terminal branch, which emits PLAIN
 * TEXT and breaks the documented "every error path emits the JSON envelope"
 * contract.
 *
 * `exitWithError` stays in tail position inside the wrapper, preserving the
 * Windows-safe "never process.exit() post-fetch" constraint documented on it.
 */
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";

/**
 * Canonical tail: `getClient()` -> `run(client, ...args)` -> `writeJson(result)`,
 * with every throw (including "Not logged in" from `getClient`) routed to
 * `exitWithError`. Commander passes positionals, then the options object, then
 * the Command — `A` captures whatever that action declares.
 */
export function jsonAction<A extends unknown[]>(
  getClient: () => Promise<ApiClient>,
  run: (client: ApiClient, ...args: A) => unknown
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      writeJson(await run(await getClient(), ...args));
    } catch (e) {
      exitWithError(e);
    }
  };
}

/**
 * Same error routing for an action body that does more than the canonical tail
 * (extra guards, its own `writeJson` shape, no client at all, or an exit code
 * set after the write). Use when `jsonAction` does not fit, so the try/catch
 * still is not hand-written.
 */
export function guarded<A extends unknown[]>(
  body: (...args: A) => unknown
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await body(...args);
    } catch (e) {
      exitWithError(e);
    }
  };
}
