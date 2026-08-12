import { writeJson, setExitCode } from "../../../output/json.js";
import { guarded } from "../../_shared/action.js";
export async function runDbTargetGet(client) {
    return (await client.get("/api/dev/db-target"));
}
export async function runDbTargetSet(client, target) {
    return client.post("/api/dev/db-target", { target });
}
export function registerDbTargetCommands(parent, getClient) {
    // A node with subcommands is a GROUP in this CLI and groups are not runnable
    // (test/reference/spec-examples-parse.test.ts enforces it), so `show` is a
    // subcommand rather than an action on `db-target` itself — same shape as
    // `dev impersonation`.
    const cmd = parent
        .command("db-target")
        .description("Which SQL database the LOCAL backend is on (loopback-only; pass --endpoint http://127.0.0.1:8080)");
    cmd
        .command("show")
        .description("Print the local backend's current SQL target")
        .option("--expect <target>", "Exit 1 if the live target is not this (dev|prod)")
        .action(guarded(async (opts) => {
        const current = await runDbTargetGet(await getClient());
        if (!opts.expect)
            return writeJson(current);
        const matches = current.target === opts.expect;
        writeJson({ ...current, expected: opts.expect, matches });
        // Deliberately AFTER the write: the caller still gets the full picture,
        // and the non-zero code is what lets a script stop before it writes.
        if (!matches)
            setExitCode(1);
    }));
    cmd
        .command("set <target>")
        .description("Repoint the local backend at dev|prod (previews unless --confirm; flushes the cache)")
        .option("--confirm", "Execute the switch (default is a preview)")
        .action(guarded(async (target, opts) => {
        const client = await getClient();
        const current = await runDbTargetGet(client);
        if (!opts.confirm) {
            // Preview mirrors the `dev cache` verbs: nothing is sent without --confirm.
            return writeJson({
                dryRun: true,
                from: current.target,
                to: target,
                wouldFlushCache: true,
                hint: current.target === target
                    ? `already on "${target}" — --confirm would be a no-op`
                    : `re-run with --confirm to switch; this flushes the whole cache, and every subsequent write goes to "${target}"`,
            });
        }
        writeJson(await runDbTargetSet(client, target));
    }));
}
//# sourceMappingURL=index.js.map