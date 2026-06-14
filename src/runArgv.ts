import { buildProgram, enableParserThrow, handleParseRejection, applySpecErrors } from "./program.js";
import { runEmbedded, type EmbeddedCtx } from "./embedded.js";

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
  const program = buildProgram();
  const parserText = enableParserThrow(program);

  // Mirror bin/ib.ts: resolve each command's CommandSpec errors for hint output.
  program.hook("preAction", (_t, actionCommand) => applySpecErrors(actionCommand));

  const ctx: EmbeddedCtx = {
    token: opts.token,
    endpoint: opts.endpoint,
    readOnly: opts.readOnly ?? false,
    outputMode: "json",
    activeCommandErrors: null,
    stdout: [],
    stderr: [],
    exitCode: null,
  };

  await runEmbedded(ctx, async () => {
    try {
      await program.parseAsync(["node", "ib", ...argv]);
    } catch (err) {
      handleParseRejection(err, parserText);
    }
  });

  return {
    exitCode: ctx.exitCode ?? 0,
    stdout: ctx.stdout.join(""),
    stderr: ctx.stderr.join(""),
  };
}
