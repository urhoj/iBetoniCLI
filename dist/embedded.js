import { AsyncLocalStorage } from "node:async_hooks";
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
export function makeEmbeddedCtx(seed) {
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
        stdout: [],
        stderr: [],
        exitCode: null,
    };
}
const als = new AsyncLocalStorage();
/** The per-invocation embedded context, or undefined for normal CLI use. */
export function getEmbeddedCtx() {
    return als.getStore();
}
/** Run `fn` with `ctx` as the active embedded context (concurrency-safe). */
export function runEmbedded(ctx, fn) {
    return als.run(ctx, fn);
}
//# sourceMappingURL=embedded.js.map