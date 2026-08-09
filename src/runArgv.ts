import { buildProgram, enableParserThrow, handleParseRejection, applySpecErrors } from "./program.js";
import { runEmbedded, type EmbeddedCtx } from "./embedded.js";
import { resolveCallerTier } from "./tier.js";
import { setAmbientCommandPath, commandPathOf } from "./commandContext.js";

export interface RunArgvOpts {
  token: string;
  endpoint: string;
  readOnly?: boolean;
}

export interface RunArgvResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run an `ib` argv inside this process and return its captured result instead
 * of writing to stdout/exiting. A FRESH program is built per call: the
 * enableParserThrow accumulator is per-program shared state, so a cached
 * program is not concurrency-safe (build is a few ms vs the ~400 ms spawn it
 * replaces). Always JSON output; never touches process stdout/stderr/exitCode.
 */
export async function runArgv(
  argv: string[],
  opts: RunArgvOpts
): Promise<RunArgvResult> {
  const program = await buildProgram(argv);
  const parserHooks = enableParserThrow(program);

  // Mirror bin/ib.ts: resolve each command's CommandSpec errors for hint output.
  program.hook("preAction", (_t, actionCommand) => {
    setAmbientCommandPath(commandPathOf(actionCommand));
    applySpecErrors(actionCommand);
  });

  // The caller's tier and the running command path ride in the EmbeddedCtx
  // (per-call via AsyncLocalStorage) — getCallerTier/getAmbientCommandPath read
  // them ahead of the module-global ambient holders, so interleaved in-process
  // calls can never clobber each other's discovery render or X-Ib-Command
  // header. (This used to be a documented set/restore race on module globals.)
  const ctx: EmbeddedCtx = {
    token: opts.token,
    endpoint: opts.endpoint,
    readOnly: opts.readOnly ?? false,
    outputMode: "json",
    activeCommandErrors: null,
    listColumns: null,
    tier: resolveCallerTier(opts.token),
    commandPath: null,
    stdout: [],
    stderr: [],
    exitCode: null,
  };

  await runEmbedded(ctx, async () => {
    try {
      await program.parseAsync(["node", "ib", ...argv]);
    } catch (err) {
      handleParseRejection(err, parserHooks);
    }
  });

  return {
    exitCode: ctx.exitCode ?? 0,
    stdout: ctx.stdout.join(""),
    stderr: ctx.stderr.join(""),
  };
}
