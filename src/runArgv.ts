import { buildProgram, enableParserThrow, handleParseRejection } from "./program.js";
import { runEmbedded, type EmbeddedCtx } from "./embedded.js";
import { setActiveCommandErrors } from "./output/json.js";
import { COMMAND_SPECS } from "./reference/specs.js";
import type { Command } from "commander";

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
  program.hook("preAction", (_thisCommand, actionCommand: Command) => {
    const parts: string[] = [];
    for (let c: Command | null = actionCommand; c; c = c.parent) {
      parts.unshift(c.name());
    }
    const path = parts.join(" ");
    const spec = COMMAND_SPECS.find((s) => s.command === path);
    setActiveCommandErrors(spec?.errors ?? null);
  });

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
