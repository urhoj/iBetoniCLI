import { CliError } from "./errors.js";
/**
 * Refuse destructive cache operations against a non-local endpoint unless the
 * caller explicitly passes --force-prod.
 *
 * All deployed slots (production AND staging/latest) share one Redis (Azure
 * Managed Redis, db 0 only), so a cache write against ANY deployed endpoint is
 * production-affecting. Only a local backend (127.0.0.1 / localhost) is exempt.
 * Throws a CliError mapped to exit 3 (permission/refused) otherwise.
 */
export function assertWritableEndpoint(endpoint, forceProd) {
    let host;
    try {
        host = new URL(endpoint).hostname;
    }
    catch {
        host = endpoint;
    }
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (isLocal || forceProd)
        return;
    throw new CliError(`Refused: '${endpoint}' is a shared-cache (deployed) endpoint. Cache writes there affect production (prod and staging share one Redis). Re-run with --force-prod to override, or use a local endpoint.`, 0, null, 3);
}
//# sourceMappingURL=endpointGuard.js.map