import { buildProgram, enableParserThrow, handleParseRejection, applySpecErrors } from "./program.js";
import { runEmbedded, makeEmbeddedCtx } from "./embedded.js";
import { resolveCallerTier } from "./tier.js";
import { setAmbientCommandPath, commandPathOf } from "./commandContext.js";
import { getGlobalOptions } from "./globals.js";
import { setListColumns, setProjectionColumns } from "./output/json.js";
/**
 * Run an `ib` argv inside this process and return its captured result instead
 * of writing to stdout/exiting. A FRESH program is built per call: the
 * enableParserThrow accumulator is per-program shared state, so a cached
 * program is not concurrency-safe (build is a few ms vs the ~400 ms spawn it
 * replaces). Always JSON output; never touches process stdout/stderr/exitCode.
 */
export async function runArgv(argv, opts) {
    const program = await buildProgram(argv);
    const parserHooks = enableParserThrow(program);
    // Mirror bin/ib.ts: resolve each command's CommandSpec errors for hint
    // output, and honour the global --columns output projection (fb#451 — the
    // embedded runner used to ignore the flag entirely). The hook runs inside
    // runEmbedded, so the ctx-aware setters write to THIS call's ctx.
    program.hook("preAction", (_t, actionCommand) => {
        setAmbientCommandPath(commandPathOf(actionCommand));
        applySpecErrors(actionCommand);
        const cols = getGlobalOptions(program).columns;
        if (cols) {
            setListColumns(cols);
            setProjectionColumns(cols);
        }
    });
    // The caller's tier and the running command path ride in the EmbeddedCtx
    // (per-call via AsyncLocalStorage) — getCallerTier/getAmbientCommandPath read
    // them ahead of the module-global ambient holders, so interleaved in-process
    // calls can never clobber each other's discovery render or X-Ib-Command
    // header. (This used to be a documented set/restore race on module globals.)
    const ctx = makeEmbeddedCtx({
        token: opts.token,
        endpoint: opts.endpoint,
        readOnly: opts.readOnly ?? false,
        tier: resolveCallerTier(opts.token),
    });
    await runEmbedded(ctx, async () => {
        try {
            await program.parseAsync(["node", "ib", ...argv]);
        }
        catch (err) {
            handleParseRejection(err, parserHooks);
        }
    });
    return {
        exitCode: ctx.exitCode ?? 0,
        stdout: ctx.stdout.join(""),
        stderr: ctx.stderr.join(""),
    };
}
//# sourceMappingURL=runArgv.js.map