export class CliError extends Error {
    statusCode;
    body;
    exitCode;
    constructor(message, statusCode, body, exitCode) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
        this.exitCode = exitCode;
        this.name = "CliError";
    }
}
export function exitCodeFromStatus(status) {
    if (status === 401)
        return 2;
    if (status === 403)
        return 3;
    if (status === 404)
        return 5;
    if (status >= 400 && status < 500)
        return 4;
    if (status >= 500)
        return 6;
    return 1;
}
/**
 * Resolve the process exit code for any thrown value, honouring the documented
 * exit-code contract: a {@link CliError} carries the status-mapped code
 * (2 auth · 3 permission · 4 validation · 5 not-found · 6 server · 7 network),
 * everything else falls back to the generic `1`.
 */
export function exitCodeForError(err) {
    return err instanceof CliError ? err.exitCode : 1;
}
/** True when an error body carries the backend's unmatched-route marker. */
function isRouteNotFound(body) {
    return (!!body &&
        typeof body === "object" &&
        body.code === "ROUTE_NOT_FOUND");
}
/**
 * Remedy hint for an error, echoed into the stderr error envelope as `hint`.
 *
 * When the running command's spec ERRORS rows are supplied (resolved by the
 * bin preAction hook), the row matching this error's HTTP status — or, for
 * client-side errors (statusCode 0), its exit code — wins: the agent gets the
 * command's OWN documented remedy (e.g. "switch to a provider company")
 * instead of a generic one. Falls back to the per-status generic hint so an
 * agent that hasn't read --help beforehand still gets pointed at the next
 * step (most importantly the 404 deploy-gate ambiguity). `null` = no hint.
 */
export function hintForError(err, specErrors) {
    // A not-deployed/unknown route is a DIFFERENT failure class than any documented
    // resource-404, so it wins over the command's own 404 remedy. The backend marks
    // an unmatched /api/* route with code "ROUTE_NOT_FOUND" (app.js catch-all); a
    // deployed route's resource-404 (sendNotFound) carries no such code.
    if (err.statusCode === 404 && isRouteNotFound(err.body)) {
        return "route not found — this endpoint is not deployed on this backend (or the path is wrong). Check the deployed build with `ib version`; deploy-gated commands flag this in their --help NOTES.";
    }
    const specRow = specErrors?.find((r) => (r.http !== undefined && r.http === err.statusCode) ||
        (r.http === undefined && err.statusCode === 0 && r.exit === err.exitCode));
    if (specRow?.remedy)
        return specRow.remedy;
    if (err.exitCode === 7) {
        return "network failure (DNS/connection/TLS) — check connectivity and the --endpoint URL";
    }
    switch (err.statusCode) {
        case 401:
            return "token expired or invalid — run `ib auth refresh` (or `ib auth login`); IB_TOKEN sessions do not auto-refresh";
        case 403:
            return "permission denied — check the PERMISSIONS line in the command's --help and the active company via `ib auth whoami`";
        case 404:
            // Reached only when the body is NOT code:ROUTE_NOT_FOUND (handled above): so
            // the route IS deployed on a current backend → resource-not-found. The trailing
            // clause keeps the old ambiguity note for OLDER backends that predate the
            // ROUTE_NOT_FOUND catch-all (their unmatched routes still 404 without a code).
            return "not found — the id likely does not exist in the ACTIVE company. (On a current backend an undeployed endpoint instead returns code \"ROUTE_NOT_FOUND\"; older backends omit it, so a 404 there can still mean not-deployed — check `ib version`.)";
        default:
            if (err.statusCode >= 500)
                return "backend error — retry with --verbose; if it persists, file `ib feedback create --kind bug`";
            return null;
    }
}
//# sourceMappingURL=errors.js.map