import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError, setExitCode } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { runVersion, type VersionReport } from "../version/index.js";
import { runCompanyList } from "../company/index.js";
import { CliError } from "../../api/errors.js";

/**
 * `ib doctor` — one aggregated "is my setup working" report for AI/CI/new users.
 *
 * Unlike `ib auth whoami` (which reads the credentials FILE and so can't see an
 * `IB_TOKEN` env session), doctor derives identity from the resolved client's
 * JWT, so it works in both session modes. It is read-only: it decodes the token
 * (free), pings the public `/api/version` (connectivity + which build is live),
 * and does ONE authenticated read (`/api/company-selection/available`) to prove
 * the token is actually accepted by this endpoint.
 */
export interface DoctorReport {
  ok: boolean;
  cli: string;
  endpoint: string;
  readOnly: boolean;
  auth: {
    personId: number | null;
    ownerAsiakasId: number | null;
    ownerAsiakasName: string | null;
    email: string | null;
    issuedFor: string | null;
    tokenExp: string | null;
    tokenExpired: boolean | null;
  };
  connectivity: VersionReport;
  authProbe: { ok: boolean; status?: number; error?: string };
}

/**
 * Build the doctor report. Pure-ish: takes the client + endpoint resolver, makes
 * the two reads, and never throws — failures fold into the report so `ok` is the
 * single boolean an AI can branch on. `nowMs` is injectable for deterministic
 * token-expiry tests.
 */
export async function runDoctor(opts: {
  client: ApiClient;
  endpoint: string;
  cliVersion: string;
  readOnly: boolean;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DoctorReport> {
  const { client, endpoint, cliVersion, readOnly } = opts;
  const now = opts.nowMs ?? Date.now();

  // Identity + token health from the JWT (no network).
  const claims = decodeJwtPayload(client.getCurrentToken());
  const tokenExp = claims.exp ? new Date(claims.exp * 1000).toISOString() : null;
  const tokenExpired = claims.exp != null ? claims.exp * 1000 < now : null;

  // Connectivity (public, no auth) — reuse the version probe.
  const connectivity = await runVersion({
    endpoint,
    cliVersion,
    fetchImpl: opts.fetchImpl,
  });

  // Authenticated probe: does this token actually work against this endpoint?
  let authProbe: DoctorReport["authProbe"];
  try {
    await runCompanyList(client);
    authProbe = { ok: true };
  } catch (e) {
    if (e instanceof CliError) {
      authProbe = { ok: false, status: e.statusCode, error: e.message };
    } else {
      authProbe = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const ok = connectivity.reachable && authProbe.ok && tokenExpired !== true;

  return {
    ok,
    cli: cliVersion,
    endpoint,
    readOnly,
    auth: {
      personId: claims.personId ?? null,
      ownerAsiakasId: claims.ownerAsiakasId ?? null,
      ownerAsiakasName: claims.ownerAsiakasName ?? null,
      email: claims.email ?? null,
      issuedFor: claims.issuedFor ?? null,
      tokenExp,
      tokenExpired,
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
export function registerDoctorCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  getEndpoint: () => Promise<string>,
  cliVersion: string,
  isReadOnly: () => boolean
): void {
  parent
    .command("doctor")
    .description(
      "Aggregated health check: identity, token expiry, connectivity (deployed build), and an authenticated probe"
    )
    .action(async () => {
      try {
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
        if (!report.ok) setExitCode(1);
      } catch (e) {
        exitWithError(e);
      }
    });
}
