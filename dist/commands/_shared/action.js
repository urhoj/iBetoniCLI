import { writeJson, exitWithError } from "../../output/json.js";
/**
 * Canonical tail: `getClient()` -> `run(client, ...args)` -> `writeJson(result)`,
 * with every throw (including "Not logged in" from `getClient`) routed to
 * `exitWithError`. Commander passes positionals, then the options object, then
 * the Command — `A` captures whatever that action declares.
 */
export function jsonAction(getClient, run) {
    return async (...args) => {
        try {
            writeJson(await run(await getClient(), ...args));
        }
        catch (e) {
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
export function guarded(body) {
    return async (...args) => {
        try {
            await body(...args);
        }
        catch (e) {
            exitWithError(e);
        }
    };
}
//# sourceMappingURL=action.js.map