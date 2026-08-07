#!/usr/bin/env node
import { buildProgram, enableParserThrow, handleParseRejection, applySpecErrors, } from "../program.js";
import { getGlobalOptions } from "../globals.js";
import { enableStats, flushStats } from "../stats.js";
import { setOutputMode, setListColumns } from "../output/json.js";
import { resolveAuth } from "../auth/resolve.js";
import { defaultCredentialsPath } from "../auth/store.js";
import { setCallerTier, resolveCallerTier } from "../tier.js";
import { setAmbientCommandPath, commandPathOf } from "../commandContext.js";
// Start the credentials read BEFORE the module-loading program build — the two
// are independent, so the file IO overlaps the imports instead of serializing
// after them. Awaited below for the tier. `.catch` here so an early rejection
// can't surface as an unhandled rejection while the build is still running.
const authPromise = resolveAuth({ credentialsPath: defaultCredentialsPath() }).catch(() => null);
// The argv hint lets buildProgram import ONLY the invoked domain's modules.
const program = await buildProgram(process.argv.slice(2));
// Throw-instead-of-exit for the parser (usage errors become the JSON envelope
// in handleParseRejection; help/version pass through) + capture its stderr.
const { parserText, erroringCommand } = enableParserThrow(program);
program.hook("preAction", (_thisCommand, actionCommand) => {
    if (getGlobalOptions(program).pretty)
        setOutputMode("pretty");
    if (getGlobalOptions(program).stats)
        enableStats();
    // Which command is running — attached to every request as X-Ib-Command
    // (command NAMES only) for the /systemmap live-activity stream.
    setAmbientCommandPath(commandPathOf(actionCommand));
    // Resolve the running command's CommandSpec so error envelopes can echo ITS
    // documented per-error remedy as `hint` (feedback #25). Shared with runArgv.
    applySpecErrors(actionCommand);
    // AFTER applySpecErrors, which seeds the spec's own prettyColumns: an
    // explicit --columns is the caller's override and must win.
    const cols = getGlobalOptions(program).columns;
    if (cols)
        setListColumns(cols);
});
// Resolve the caller's visibility tier from the session token BEFORE parse so
// discovery (`ib commands`, `ib reference dump`, root primer) renders at the
// caller's tier. Fail-closed: any resolution failure → "standard" (privileged
// subtrees hidden).
try {
    setCallerTier(resolveCallerTier((await authPromise)?.token ?? null));
}
catch {
    setCallerTier("standard");
}
await program.parseAsync(process.argv).catch((err) => {
    // The preAction hook above never fired (no action ran), so the output mode is
    // still the JSON default — set it here or `--pretty` is a silent no-op on
    // every usage error. Commander consumes ROOT options before subcommand
    // dispatch, so the flag is known even though routing failed. Read
    // `program.opts()` and not `getGlobalOptions`: the latter validates --company
    // and THROWS, which inside this catch would escape as an unhandled rejection.
    // Doing it here rather than before parseAsync is deliberate — the parse has
    // already failed, so this can only ever affect an error render, never flip a
    // successful command's stdout out of JSON.
    if (program.opts().pretty)
        setOutputMode("pretty");
    handleParseRejection(err, parserText, erroringCommand);
});
// Same reason: `getGlobalOptions` here threw a raw CliError stack trace past the
// handled envelope on `ib … --company abc`, clobbering exit 4 with exit 1.
flushStats({ pretty: !!program.opts().pretty });
//# sourceMappingURL=ib.js.map