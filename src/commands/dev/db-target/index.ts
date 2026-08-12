/**
 * `ib dev db-target` — which SQL database the LOCAL backend is talking to.
 *
 * Exists because a local backend can be repointed at PRODUCTION and nothing
 * surfaced that outside the puminet4 header chip, so it stayed invisible until
 * someone looked (feedback #430). `--expect` is what lets a script fail closed
 * before it writes.
 *
 * The route is loopback-only (puminet5api routes/devRoutes.js `devLoopbackOnly`
 * + a NODE_ENV=production guard), so it 404s on every deployed backend — the
 * spec's 404 remedy says a 404 means "not a local backend", not "no such
 * command".
 */
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { writeJson, setExitCode } from "../../../output/json.js";
import { jsonAction, guarded } from "../../_shared/action.js";

export interface DbTargetDescription {
  target: string;
  targets: string[];
  switchable: boolean;
  server: string;
  database: string;
  missing: string[];
  complete: boolean;
}

export interface DbTargetShown extends DbTargetDescription {
  expected?: string;
  matches?: boolean;
}

export async function runDbTargetShow(
  client: ApiClient,
  opts: { expect?: string } = {}
): Promise<DbTargetShown> {
  const current = await client.get<DbTargetDescription>("/api/dev/db-target");
  if (!opts.expect) return current;
  return { ...current, expected: opts.expect, matches: current.target === opts.expect };
}

/**
 * Preview unless `confirm`, mirroring the `dev cache` verbs. The preview reads
 * the current target so it can name what you are moving away from; the execute
 * path does not, because the response carries the new state.
 */
export async function runDbTargetSet(
  client: ApiClient,
  target: string,
  confirm: boolean
): Promise<unknown> {
  if (confirm) return client.post("/api/dev/db-target", { target });
  const current = await client.get<DbTargetDescription>("/api/dev/db-target");
  const noop = current.target === target;
  return {
    dryRun: true,
    from: current.target,
    to: target,
    // The backend flushes only when the target actually changes
    // (routes/devRoutes.js: `if (result.changed)`).
    wouldFlushCache: !noop,
    hint: noop
      ? `already on "${target}" — --confirm would be a no-op`
      : `re-run with --confirm to switch; this flushes the whole cache, and every subsequent write goes to "${target}"`,
  };
}

export function registerDbTargetCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const cmd = parent
    .command("db-target")
    .description(
      "Which SQL database the LOCAL backend is on (loopback-only; pass --endpoint http://127.0.0.1:8080)"
    );

  cmd
    .command("show")
    .option("--expect <target>", "Exit 1 if the live target is not this (dev|prod)")
    .action(
      guarded(async (opts: { expect?: string }) => {
        const shown = await runDbTargetShow(await getClient(), opts);
        writeJson(shown);
        // Deliberately AFTER the write: the caller still gets the full picture,
        // and the non-zero code is what lets a script stop before it writes.
        if (shown.matches === false) setExitCode(1);
      })
    );

  cmd
    .command("set <target>")
    .option("--confirm", "Execute the switch (default is a preview)")
    .action(
      jsonAction(getClient, (client, target: string, opts: { confirm?: boolean }) =>
        runDbTargetSet(client, target, !!opts.confirm)
      )
    );
}
