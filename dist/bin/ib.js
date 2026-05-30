#!/usr/bin/env node
import { buildProgram } from "../program.js";
import { getGlobalOptions } from "../globals.js";
import { setOutputMode } from "../output/json.js";
const program = buildProgram();
program.hook("preAction", () => {
    if (getGlobalOptions(program).pretty)
        setOutputMode("pretty");
});
program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`${err.message || err}\n`);
    process.exit(1);
});
//# sourceMappingURL=ib.js.map