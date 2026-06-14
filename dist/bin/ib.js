#!/usr/bin/env node
import { buildProgram, enableParserThrow, handleParseRejection, applySpecErrors, } from "../program.js";
import { getGlobalOptions } from "../globals.js";
import { setOutputMode } from "../output/json.js";
const program = buildProgram();
// Throw-instead-of-exit for the parser (usage errors become the JSON envelope
// in handleParseRejection; help/version pass through) + capture its stderr.
const parserText = enableParserThrow(program);
program.hook("preAction", (_thisCommand, actionCommand) => {
    if (getGlobalOptions(program).pretty)
        setOutputMode("pretty");
    // Resolve the running command's CommandSpec so error envelopes can echo ITS
    // documented per-error remedy as `hint` (feedback #25). Shared with runArgv.
    applySpecErrors(actionCommand);
});
program
    .parseAsync(process.argv)
    .catch((err) => handleParseRejection(err, parserText));
//# sourceMappingURL=ib.js.map