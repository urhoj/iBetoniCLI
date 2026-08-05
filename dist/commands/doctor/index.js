import { writeJson, setExitCode } from "../../output/json.js";
import { decodeJwtPayload, impersonationFromClaims } from "../../auth/jwt.js";
import { resolveCallerTier } from "../../tier.js";
import { runVersion } from "../version/index.js";
import { runCompanyList } from "../company/index.js";
import { CliError } from "../../api/errors.js";
import { guarded } from "../_shared/action.js";
/**
 * Build the doctor report. Pure-ish: takes the client + endpoint resolver, makes
 * the two reads, and never throws — failures fold into the report so `ok` is the
 * single boolean an AI can branch on. `nowMs` is injectable for deterministic
 * token-expiry tests.
 */
export async function runDoctor(opts) {
    const { client, endpoint, cliVersion, readOnly } = opts;
    const now = opts.nowMs ?? Date.now();
    // Identity + token health from the JWT (no network).
    const token = client.getCurrentToken();
    const claims = decodeJwtPayload(token);
    const tier = resolveCallerTier(token);
    const tokenExp = claims.exp ? new Date(claims.exp * 1000).toISOString() : null;
    const tokenExpired = claims.exp != null ? claims.exp * 1000 < now : null;
    const impersonating = impersonationFromClaims(claims);
    // Two independent probes, run concurrently: connectivity (public, no auth —
    // reuses the version probe) and the authenticated read proving the token
    // works against this endpoint. The auth probe never throws — failures fold
    // into the report.
    const [connectivity, authProbe] = await Promise.all([
        runVersion({ endpoint, cliVersion, fetchImpl: opts.fetchImpl }),
        runCompanyList(client).then(() => ({ ok: true }), (e) => e instanceof CliError
            ? { ok: false, status: e.statusCode, error: e.message }
            : { ok: false, error: e instanceof Error ? e.message : String(e) }),
    ]);
    const ok = connectivity.reachable && authProbe.ok && tokenExpired !== true;
    return {
        ok,
        cli: cliVersion,
        endpoint,
        readOnly,
        auth: {
            personId: claims.personId ?? null,
            email: claims.email ?? null,
            tier,
            ownerAsiakasId: claims.ownerAsiakasId ?? null,
            ownerAsiakasName: claims.ownerAsiakasName ?? null,
            companies: claims.companies,
            issuedFor: claims.issuedFor ?? null,
            tokenExp,
            tokenExpired,
            ...(impersonating ? { impersonating } : {}),
        },
        connectivity,
        authProbe,
    };
}
/**
 * Register `ib doctor`. Takes `getClient` (auth required — a not-logged-in
 * session exits 2 via the factory before doctor runs), an endpoint resolver, the
 * CLI version, and a read-only resolver (reflected in the report). Exits 1 when
 * the aggregate `ok` is false, so CI can gate on the exit code alone.
 */
export function registerDoctorCommand(parent, getClient, getEndpoint, cliVersion, isReadOnly) {
    parent
        .command("doctor")
        .action(guarded(async () => {
        const client = await getClient();
        const endpoint = await getEndpoint();
        const report = await runDoctor({
            client,
            endpoint,
            cliVersion,
            readOnly: isReadOnly(),
        });
        writeJson(report);
        // Set the code and RETURN (don't process.exit) so stdout drains first.
        if (!report.ok)
            setExitCode(1);
    }));
}
//# sourceMappingURL=index.js.map