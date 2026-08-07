import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandError } from "./output/help.js";
import type { CallerTier } from "./tier.js";

export interface EmbeddedCtx {
  token: string;
  endpoint: string;
  readOnly: boolean;
  outputMode: "json" | "pretty";
  activeCommandErrors: CommandError[] | null;
  listColumns: readonly string[] | null;
  /**
   * The caller's visibility tier, resolved from THEIR token. Read by
   * `getCallerTier()` ahead of the module-global ambient holder, so two
   * interleaved in-process calls can never clobber each other's discovery
   * render window (the race the old set/restore dance in runArgv documented).
   */
  tier: CallerTier;
  /** The running command's path for X-Ib-Command — ctx-aware for the same reason. */
  commandPath: string | null;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

const als = new AsyncLocalStorage<EmbeddedCtx>();

/** The per-invocation embedded context, or undefined for normal CLI use. */
export function getEmbeddedCtx(): EmbeddedCtx | undefined {
  return als.getStore();
}

/** Run `fn` with `ctx` as the active embedded context (concurrency-safe). */
export function runEmbedded<T>(ctx: EmbeddedCtx, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
