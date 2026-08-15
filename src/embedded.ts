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
  /** Explicit global `--columns` output projection (fb#451) — see `output/json.ts`. */
  projectionColumns: readonly string[] | null;
  /**
   * The caller's visibility tier, resolved from THEIR token. Read by
   * `getCallerTier()` ahead of the module-global ambient holder, so two
   * interleaved in-process calls can never clobber each other's discovery
   * render window (the race the old set/restore dance in runArgv documented).
   */
  tier: CallerTier;
  /** The running command's path for X-Ib-Command — ctx-aware for the same reason. */
  commandPath: string | null;
  /**
   * The caller's feedback-claim label, ctx-aware for the same reason as `tier`
   * (fb#616). In-process calls share ONE process env, so reading IB_CLAIM_ID
   * from `process.env` would give every concurrent hosted caller the same
   * identity — and a claim lease whose holders are indistinguishable does not
   * lock anything. Null = no identity was supplied; see resolveClaimId.
   */
  claimId: string | null;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * What a caller may seed. The identity fields are required; the read-side fields
 * default; the three output accumulators are always fresh and cannot be passed.
 */
type EmbeddedCtxSeed = Pick<EmbeddedCtx, "token" | "endpoint" | "tier"> &
  Partial<
    Omit<EmbeddedCtx, "token" | "endpoint" | "tier" | "stdout" | "stderr" | "exitCode">
  >;

/**
 * Build a COMPLETE {@link EmbeddedCtx}. The only supported way to make one.
 *
 * Every ctx-aware read in `output/json.ts` is `getEmbeddedCtx()?.field ?? moduleState`,
 * so a ctx built with a field MISSING does not fail — it silently falls through
 * to module-level state while INSIDE embedded mode, i.e. reads another
 * invocation's setting. Nothing caught that: `runArgv` was the sole production
 * constructor and happened to be complete, and `test/` was not type-checked, so
 * adding a required field (`projectionColumns`, fb#451) broke no build and no
 * test (fb#487).
 *
 * Defaulting here makes the fallthrough impossible by construction — a caller
 * passes only what varies, and a new field gets its default in ONE place. Note
 * the defaults are written out field-by-field rather than spread over the seed:
 * a spread lets an explicitly-passed `undefined` reinstate exactly the hole this
 * exists to close, and the explicit literal is what turns a newly-added
 * `EmbeddedCtx` field into a compile error right here.
 */
export function makeEmbeddedCtx(seed: EmbeddedCtxSeed): EmbeddedCtx {
  return {
    token: seed.token,
    endpoint: seed.endpoint,
    tier: seed.tier,
    readOnly: seed.readOnly ?? false,
    outputMode: seed.outputMode ?? "json",
    activeCommandErrors: seed.activeCommandErrors ?? null,
    listColumns: seed.listColumns ?? null,
    projectionColumns: seed.projectionColumns ?? null,
    commandPath: seed.commandPath ?? null,
    claimId: seed.claimId ?? null,
    stdout: [],
    stderr: [],
    exitCode: null,
  };
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
