/**
 * `ib dev migration run` — run one committed, DEPLOYED puminet5api
 * migrations/run-*.js runner on the backend (fb#1851).
 *
 * A cloud session has no DB credentials, so a data fix it wrote could never be
 * applied from there (fb#2151 sat 11 days). The backend spawns the deployed
 * runner with the app's own env; only --dry-run / --expect-db reach it, and the
 * runner's own assertDbTarget still decides whether it may write.
 *
 * The response is the runner's outcome; a non-zero runner exit (a refusal or a
 * failure) becomes exit 1 here, after the JSON is written, so the output is
 * never lost.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { failWith, writeJson } from "../../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../../api/writeFlags.js";
import { guarded } from "../../_shared/action.js";

export interface MigrationRunResult {
  basename: string;
  dryRun: boolean;
  expectDb: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  runLog: string | null;
}

/** POST /api/cli/migration/run */
export async function runMigrationRun(
  client: ApiClient,
  basename: string,
  opts: { expectDb?: string } & WriteFlags
): Promise<MigrationRunResult> {
  if (!opts.dryRun && !opts.expectDb) {
    failWith("pass --dry-run first, then --expect-db=<name> (the dry run prints the target database)", 4);
  }
  return client.post<MigrationRunResult>(
    "/api/cli/migration/run",
    { basename, expectDb: opts.expectDb },
    { headers: writeFlagsToHeaders(opts) }
  );
}

export function registerMigrationCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  const cmd = parent
    .command("migration")
    .description("Run a committed, deployed puminet5api migrations/run-*.js runner on the backend (no local DB access needed).");

  addWriteFlagsToCommand(
    cmd
      .command("run <basename>")
      .option("--expect-db <name>", "Database the runner must see to write (the dry run prints it)")
  ).action(
    guarded(async (basename: string, opts: { expectDb?: string } & WriteFlags) => {
      const result = await runMigrationRun(await getClient(), basename, opts);
      writeJson(result);
      if (result.exitCode !== 0) process.exitCode = 1;
    })
  );
}
