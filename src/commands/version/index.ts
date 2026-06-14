import type { Command } from "commander";
import { writeJson, setExitCode } from "../../output/json.js";

/**
 * `ib version` — report the local CLI version AND the deployed iB version at the
 * active endpoint, so you can see which build is live on staging vs prod.
 *
 * Why a server round-trip: the entire deployable iB surface — the `/api/cli/*`
 * routes AND the vendored `betonicli/dist` — ships inside `puminet5api`. So one
 * puminet5api deploy = the deployed iB surface, and its commit SHA (exposed by
 * `GET /api/version` from the deploy-written `release.txt`) is the single source
 * of truth for "what iB is running here". It changes on every deployed commit,
 * so no manual version bump is needed to tell builds apart.
 *
 * Unauthenticated by design: `GET /api/version` is public, so `ib version` works
 * logged out and against any `--endpoint` (handy for confirming a deploy landed).
 */

/** The deployment-identity fields returned by `GET /api/version`. */
export interface ServerVersion {
  app: string | null;
  version: string | null;
  /** Short git SHA of the deployed build (null in dev — no release.txt). */
  commit: string | null;
  /** "<version>+<shortSha>" — matches the Sentry release. */
  release: string | null;
  /** "production" | "staging" | <NODE_ENV> — which environment the endpoint serves. */
  slot: string | null;
}

export interface VersionReport {
  cli: string;
  endpoint: string;
  reachable: boolean;
  server: ServerVersion | null;
  error?: string;
}

/** Coerce an unknown JSON value to a string field, preserving null/absent as null. */
function asStr(v: unknown): string | null {
  if (typeof v === "string") return v;
  return v == null ? null : String(v);
}

/**
 * Fetch `GET <endpoint>/api/version` (no auth) and fold it into a VersionReport.
 * Never throws: a non-2xx or network failure returns `reachable: false` with the
 * detail in `error`, so the local `cli` version is always reported. Pure /
 * injectable (`fetchImpl`) so it is unit-testable without spawning the CLI.
 */
export async function runVersion(opts: {
  endpoint: string;
  cliVersion: string;
  fetchImpl?: typeof fetch;
}): Promise<VersionReport> {
  const { endpoint, cliVersion } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${endpoint.replace(/\/+$/, "")}/api/version`;
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": `ib-cli/${cliVersion}`, Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        cli: cliVersion,
        endpoint,
        reachable: false,
        server: null,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      cli: cliVersion,
      endpoint,
      reachable: true,
      server: {
        app: asStr(body.app),
        version: asStr(body.version),
        commit: asStr(body.commit),
        release: asStr(body.release),
        slot: asStr(body.slot),
      },
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { cli: cliVersion, endpoint, reachable: false, server: null, error: detail };
  }
}

/**
 * Register `ib version`. Unlike domain commands it takes no `getClient` (the
 * endpoint is public) — just the CLI version and an endpoint resolver that
 * mirrors the normal `--endpoint` → active-profile → default chain. Exits 7
 * (network) when the endpoint can't be reached, but still prints the report.
 */
export function registerVersionCommand(
  parent: Command,
  cliVersion: string,
  getEndpoint: () => Promise<string>
): void {
  parent
    .command("version")
    .description(
      "Show the local CLI version + the deployed iB version (commit SHA + slot) at the active endpoint"
    )
    .action(async () => {
      const endpoint = await getEndpoint();
      const report = await runVersion({ endpoint, cliVersion });
      writeJson(report);
      // Unreachable → exit 7 (network). Set the code and RETURN (don't
      // process.exit) so the JSON on stdout drains first — a hard exit truncates
      // piped output on Windows, and piped stdout is this CLI's primary mode.
      if (!report.reachable) setExitCode(7);
    });
}
