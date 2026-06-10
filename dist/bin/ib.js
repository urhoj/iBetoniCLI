#!/usr/bin/env node
import { buildProgram, enableParserThrow, handleParseRejection, } from "../program.js";
import { getGlobalOptions } from "../globals.js";
import { setOutputMode, setActiveCommandErrors } from "../output/json.js";
import { COMMAND_SPECS } from "../reference/specs.js";
const program = buildProgram();
// Throw-instead-of-exit for the parser (usage errors become the JSON envelope
// in handleParseRejection; help/version pass through) + capture its stderr.
const parserText = enableParserThrow(program);
program.hook("preAction", (_thisCommand, actionCommand) => {
    if (getGlobalOptions(program).pretty)
        setOutputMode("pretty");
    // Resolve the running command's CommandSpec so error envelopes can echo ITS
    // documented per-error remedy as `hint` (feedback #25). Spec-less commands
    // (none today — wiring tests enforce coverage) fall back to generic hints.
    const parts = [];
    for (let c = actionCommand; c; c = c.parent) {
        parts.unshift(c.name());
    }
    const path = parts.join(" ");
    const spec = COMMAND_SPECS.find((s) => s.command === path);
    setActiveCommandErrors(spec?.errors ?? null);
});
program
    .parseAsync(process.argv)
    .catch((err) => handleParseRejection(err, parserText));
//# sourceMappingURL=ib.js.map