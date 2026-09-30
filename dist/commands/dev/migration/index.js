import { failWith, writeJson } from "../../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../../api/writeFlags.js";
import { guarded } from "../../_shared/action.js";
/** POST /api/cli/migration/run */
export async function runMigrationRun(client, basename, opts) {
    if (!opts.dryRun && !opts.expectDb) {
        failWith("pass --dry-run first, then --expect-db=<name> (the dry run prints the target database)", 4);
    }
    return client.post("/api/cli/migration/run", { basename, expectDb: opts.expectDb }, { headers: writeFlagsToHeaders(opts) });
}
export function registerMigrationCommands(parent, getClient) {
    const cmd = parent
        .command("migration")
        .description("Run a committed, deployed puminet5api migrations/run-*.js runner on the backend (no local DB access needed).");
    addWriteFlagsToCommand(cmd
        .command("run <basename>")
        .option("--expect-db <name>", "Database the runner must see to write (the dry run prints it)")).action(guarded(async (basename, opts) => {
        const result = await runMigrationRun(await getClient(), basename, opts);
        writeJson(result);
        if (result.exitCode !== 0)
            process.exitCode = 1;
    }));
}
//# sourceMappingURL=index.js.map