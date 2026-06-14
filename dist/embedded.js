import { AsyncLocalStorage } from "node:async_hooks";
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