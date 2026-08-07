/**
 * Ambient "which ib command is running" holder + the Commander-chain path
 * helper. Set once per invocation by the entry points (bin/ib.ts, runArgv.ts)
 * in their preAction hooks; read by the API client (buildHeaders) to attach
 * the X-Ib-Command header — the backend batches these into the /systemmap
 * live-activity socket stream (ibActivity:batch).
 *
 * COMMAND NAMES ONLY: the value is derived from Commander command names,
 * never positionals or flag values, so no user data can leak into the header.
 * Ctx-aware like the ambient tier: an embedded invocation reads/writes its
 * EmbeddedCtx.commandPath (per-call via AsyncLocalStorage), so interleaved
 * in-process calls cannot clobber each other's header.
 */
import { getEmbeddedCtx } from "./embedded.js";
/** Commander chain -> "dev feedback get" (root program name excluded). */
export function commandPathOf(cmd) {
    const names = [];
    let c = cmd;
    while (c && c.parent) {
        names.unshift(c.name());
        c = c.parent;
    }
    return names.join(" ");
}
let ambientCommandPath = null;
export function setAmbientCommandPath(path) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.commandPath = path || null;
    else
        ambientCommandPath = path || null;
}
export function getAmbientCommandPath() {
    const ctx = getEmbeddedCtx();
    return ctx ? ctx.commandPath : ambientCommandPath;
}
//# sourceMappingURL=commandContext.js.map