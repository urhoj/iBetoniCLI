import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
const DEFAULTS = {
    pollMs: 100,
    // A refresh round-trip is ~1-2 s; a lock older than this has no live holder.
    staleMs: 15_000,
    capMs: 20_000,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function acquire(lockPath, o) {
    const deadline = Date.now() + o.capMs;
    for (;;) {
        try {
            await mkdir(lockPath);
            return true;
        }
        catch (e) {
            const code = e.code;
            if (code === "ENOENT") {
                // Parent dir missing (first-ever run) — create it and retry.
                await mkdir(dirname(lockPath), { recursive: true }).catch(() => { });
                continue;
            }
            if (code !== "EEXIST")
                return false; // unexpected fs error — proceed unlocked
        }
        try {
            const s = await stat(lockPath);
            if (Date.now() - s.mtimeMs > o.staleMs) {
                // Orphaned by a dead holder — break it. Two waiters may both rm and
                // both retry the mkdir; exactly one wins, the other loops.
                await rm(lockPath, { recursive: true, force: true }).catch(() => { });
                continue;
            }
        }
        catch {
            continue; // vanished between mkdir and stat — retry immediately
        }
        if (Date.now() >= deadline)
            return false; // give up; proceed unlocked
        await sleep(o.pollMs);
    }
}
/**
 * Run `fn` holding the exclusive lock at `lockPath` (a directory created and
 * removed around the call). Never throws for lock reasons: on any acquisition
 * failure `fn` runs unlocked (see module doc). A lock this process did not
 * acquire is never removed.
 */
export async function withFileLock(lockPath, fn, options = {}) {
    const acquired = await acquire(lockPath, { ...DEFAULTS, ...options });
    try {
        return await fn();
    }
    finally {
        if (acquired)
            await rm(lockPath, { recursive: true, force: true }).catch(() => { });
    }
}
//# sourceMappingURL=lock.js.map