#!/usr/bin/env node
import { buildProgram } from "../program.js";
import { getGlobalOptions } from "../globals.js";
import { setOutputMode, exitWithError } from "../output/json.js";
import { CliError } from "../api/errors.js";

const program = buildProgram();

program.hook("preAction", () => {
  if (getGlobalOptions(program).pretty) setOutputMode("pretty");
});

program.parseAsync(process.argv).catch((err) => {
  // A CliError thrown outside any action try-block (failWith guards, global
  // option validation) still gets the stderr envelope + its mapped exit code.
  if (err instanceof CliError) {
    exitWithError(err);
    return;
  }
  process.stderr.write(`${err.message || err}\n`);
  // exitCode + natural drain, NOT process.exit(): forced exit after a fetch
  // crashes Node on Windows (libuv UV_HANDLE_CLOSING assert → exit 127).
  process.exitCode = 1;
});
