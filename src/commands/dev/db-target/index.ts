/**
 * `ib dev db-target` — which SQL database the LOCAL backend is talking to.
 *
 * Why this exists (feedback #430): the backend has answered
 * GET/POST /api/dev/db-target for a while, and the target is switchable between
 * dev and prod, but nothing surfaced it from the CLI. The only ways to find out
 * were the DbTargetChip in the puminet4 header or a hand-rolled curl with a
 * bearer token — so a local backend silently repointed at production stayed
 * invisible until someone happened to look at the UI. Any local test that writes
 * would have written real production rows.
 *
 * `--expect <target>` is the point of the command for automation: it still emits
 * the JSON, and exits 1 when the live target is not the one you assumed, so a
 * routine can fail closed BEFORE it writes rather than discover it afterwards.
 *
 * ENDPOINT: this route is loopback-only and 404s on every deployed backend
 * (devLoopbackOnly + a NODE_ENV=production guard in puminet5api routes/devRoutes.js).
 * The CLI's default endpoint is the deployed API, so a bare call 404s — pass
 * `--endpoint http://127.0.0.1:8080`. The 404 remedy in the spec says so; a 404
 * here means "not a local backend", never "no such command".
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { writeJson, setExitCode } from "../../../output/json.js";
import { guarded } from "../../_shared/action.js";

export interface DbTargetDescription {
  target: string;
  targets: string[];
  switchable: boolean;
  server: string;
  database: string;
  missing: string[];
  complete: boolean;
}

export async function runDbTargetGet(client: ApiClient): Promise<DbTargetDescription> {
  return (await client.get("/api/dev/db-target")) as DbTargetDescription;
}

export async function runDbTargetSet(client: ApiClient, target: string): Promise<unknown> {
  return client.post("/api/dev/db-target", { target });
}

export function registerDbTargetCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  // A node with subcommands is a GROUP in this CLI and groups are not runnable
  // (test/reference/spec-examples-parse.test.ts enforces it), so `show` is a
  // subcommand rather than an action on `db-target` itself — same shape as
  // `dev impersonation`.
  const cmd = parent
    .command("db-target")
    .description(
      "Which SQL database the LOCAL backend is on (loopback-only; pass --endpoint http://127.0.0.1:8080)"
    );

  cmd
    .command("show")
    .description("Print the local backend's current SQL target")
    .option("--expect <target>", "Exit 1 if the live target is not this (dev|prod)")
    .action(
      guarded(async (opts: { expect?: string }) => {
        const current = await runDbTargetGet(await getClient());
        if (!opts.expect) return writeJson(current);
        const matches = current.target === opts.expect;
        writeJson({ ...current, expected: opts.expect, matches });
        // Deliberately AFTER the write: the caller still gets the full picture,
        // and the non-zero code is what lets a script stop before it writes.
        if (!matches) setExitCode(1);
      })
    );

  cmd
    .command("set <target>")
    .description("Repoint the local backend at dev|prod (previews unless --confirm; flushes the cache)")
    .option("--confirm", "Execute the switch (default is a preview)")
    .action(
      guarded(async (target: string, opts: { confirm?: boolean }) => {
        const client = await getClient();
        const current = await runDbTargetGet(client);
        if (!opts.confirm) {
          // Preview mirrors the `dev cache` verbs: nothing is sent without --confirm.
          return writeJson({
            dryRun: true,
            from: current.target,
            to: target,
            wouldFlushCache: true,
            hint:
              current.target === target
                ? `already on "${target}" — --confirm would be a no-op`
                : `re-run with --confirm to switch; this flushes the whole cache, and every subsequent write goes to "${target}"`,
          });
        }
        writeJson(await runDbTargetSet(client, target));
      })
    );
}
