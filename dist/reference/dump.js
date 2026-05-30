/**
 * `ib reference dump` — emits the entire CLI command surface as a single JSON
 * document.
 *
 * The dump is what an AI assistant ingests once at session start to know every
 * command, flag, permission, output shape, error code, and example. The same
 * {@link CommandSpec} objects back the `--help` text rendered by
 * `src/output/help.ts`, so the JSON dump and the human help can never drift
 * out of sync — there is exactly one source of truth (`./specs.ts`).
 */
import { COMMAND_SPECS } from "./specs.js";
import packageJson from "../../package.json" with { type: "json" };
/**
 * Build the reference object. Pure — no I/O — so tests can assert on it
 * directly. Commands are keyed by their full path (e.g. `ib keikka list`),
 * matching what an AI assistant sees from `--help`.
 */
export function buildReference() {
    return {
        version: packageJson.version,
        generatedAt: new Date().toISOString(),
        commands: Object.fromEntries(COMMAND_SPECS.map((spec) => [spec.command, spec])),
    };
}
/**
 * Write the reference dump as pretty-printed JSON to stdout. Used by the
 * `ib reference dump` subcommand. Trailing newline so shells / `jq` see a
 * clean line-terminated document.
 */
export function runReferenceDump() {
    process.stdout.write(JSON.stringify(buildReference(), null, 2) + "\n");
}
//# sourceMappingURL=dump.js.map