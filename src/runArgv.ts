import { buildProgram, enableParserThrow, handleParseRejection, applySpecErrors } from "./program.js";
import { runEmbedded, type EmbeddedCtx } from "./embedded.js";
import { setCallerTier, resolveCallerTier, getCallerTier } from "./tier.js";
import { setAmbientCommandPath, getAmbientCommandPath, commandPathOf } from "./commandContext.js";

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
  const { parserText, erroringCommand } = enableParserThrow(program);

  // Mirror bin/ib.ts: resolve each command's CommandSpec errors for hint output.
  program.hook("preAction", (_t, actionCommand) => {
    setAmbientCommandPath(commandPathOf(actionCommand));
    applySpecErrors(actionCommand);
  });

  // Set the caller's visibility tier for this run; restore it in finally so the
  // module-global never leaks across calls. NOTE: the ambient tier is a module
  // global (unlike stdout/exitCode, which are per-call via AsyncLocalStorage).
  // When IB_EXEC_INPROCESS is ON and two runArgv calls interleave at an await,
  // a developer-tier call's setCallerTier can clobber a concurrent standard-tier
  // call's discovery RENDER window (wrong tier in `ib commands`/`--help` output;
  // actual API calls are unaffected — they use per-call tokens via EmbeddedCtx).
  // To fix when that path goes live, thread `tier` through EmbeddedCtx instead of
  // this module global. The live path currently spawns a fresh process per call,
  // so there is no race today.
  const priorTier = getCallerTier();
  const priorCommandPath = getAmbientCommandPath();
  setCallerTier(resolveCallerTier(opts.token));

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

  try {
    await runEmbedded(ctx, async () => {
      try {
        await program.parseAsync(["node", "ib", ...argv]);
      } catch (err) {
        handleParseRejection(err, parserText, erroringCommand);
      }
    });
  } finally {
    setCallerTier(priorTier);
    setAmbientCommandPath(priorCommandPath);
  }

  return {
    exitCode: ctx.exitCode ?? 0,
    stdout: ctx.stdout.join(""),
    stderr: ctx.stderr.join(""),
  };
}
