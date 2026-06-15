import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandError } from "./output/help.js";

export interface EmbeddedCtx {
  token: string;
  endpoint: string;
  readOnly: boolean;
  outputMode: "json" | "pretty";
  activeCommandErrors: CommandError[] | null;
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
