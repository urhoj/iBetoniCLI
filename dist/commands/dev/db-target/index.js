import { writeJson, setExitCode } from "../../../output/json.js";
import { jsonAction, guarded } from "../../_shared/action.js";
export async function runDbTargetShow(client, opts = {}) {
    const current = await client.get("/api/dev/db-target");
    if (!opts.expect)
        return current;
    return { ...current, expected: opts.expect, matches: current.target === opts.expect };
}
/**
 * Preview unless `confirm`, mirroring the `dev cache` verbs. The preview reads
 * the current target so it can name what you are moving away from; the execute
 * path does not, because the response carries the new state.
 */
export async function runDbTargetSet(client, target, confirm) {
    if (confirm)
        return client.post("/api/dev/db-target", { target });
    const current = await client.get("/api/dev/db-target");
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
export function registerDbTargetCommands(parent, getClient) {
    const cmd = parent
        .command("db-target")
        .description("Which SQL database the LOCAL backend is on (loopback-only; pass --endpoint http://127.0.0.1:8080)");
    cmd
        .command("show")
        .option("--expect <target>", "Exit 1 if the live target is not this (dev|prod)")
        .action(guarded(async (opts) => {
        const shown = await runDbTargetShow(await getClient(), opts);
        writeJson(shown);
        // Deliberately AFTER the write: the caller still gets the full picture,
        // and the non-zero code is what lets a script stop before it writes.
        if (shown.matches === false)
            setExitCode(1);
    }));
    cmd
        .command("set <target>")
        .option("--confirm", "Execute the switch (default is a preview)")
        .action(jsonAction(getClient, (client, target, opts) => runDbTargetSet(client, target, !!opts.confirm)));
}
//# sourceMappingURL=index.js.map