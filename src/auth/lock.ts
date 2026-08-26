import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Cross-process mutex for the credentials file (fb#884).
 *
 * Multiple actors share ~/.ibetoni/credentials.json on one machine (parallel
 * agent sessions, scheduled tasks). The OAuth refresh token is ROTATING with
 * reuse detection: two processes that both read the same stored token and both
 * run the grant leave the loser presenting a consumed token — and the server
 * answers that by revoking the entire session family, bricking unattended
 * automation until a human browser-login. Serializing the refresh critical
 * section is the fix; the winner persists the rotation and the waiter re-reads
 * it instead of racing.
 *
 * Implementation: an atomic `mkdir` of a sibling `.lock` directory — the one
 * primitive that is atomic-exclusive on every platform including Windows (no
 * fs advisory locks in Node). BEST-EFFORT by design: a stale lock (holder
 * died) is broken after `staleMs`, and if acquisition still fails at `capMs`
 * the caller proceeds UNLOCKED — a missed lock degrades to the old racy
 * behaviour (which the reuse-recovery re-read in refresh.ts then catches),
 * while blocking forever would turn a leaked lock file into a hard outage.
 */
export interface FileLockOptions {
  /** Poll interval while the lock is held by a live process. */
  pollMs?: number;
  /** Age at which a held lock is presumed orphaned and broken. */
  staleMs?: number;
  /** Total time to spend acquiring before proceeding unlocked. */
  capMs?: number;
}

const DEFAULTS: Required<FileLockOptions> = {
  pollMs: 100,
  // A refresh round-trip is ~1-2 s; a lock older than this has no live holder.
  staleMs: 15_000,
  capMs: 20_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquire(lockPath: string, o: Required<FileLockOptions>): Promise<boolean> {
  const deadline = Date.now() + o.capMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Parent dir missing (first-ever run) — create it and retry.
        await mkdir(dirname(lockPath), { recursive: true }).catch(() => {});
        continue;
      }
      if (code !== "EEXIST") return false; // unexpected fs error — proceed unlocked
    }
    try {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > o.staleMs) {
        // Orphaned by a dead holder — break it. Two waiters may both rm and
        // both retry the mkdir; exactly one wins, the other loops.
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
    } catch {
      continue; // vanished between mkdir and stat — retry immediately
    }
    if (Date.now() >= deadline) return false; // give up; proceed unlocked
    await sleep(o.pollMs);
  }
}

/**
 * Run `fn` holding the exclusive lock at `lockPath` (a directory created and
 * removed around the call). Never throws for lock reasons: on any acquisition
 * failure `fn` runs unlocked (see module doc). A lock this process did not
 * acquire is never removed.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const acquired = await acquire(lockPath, { ...DEFAULTS, ...options });
  try {
    return await fn();
  } finally {
    if (acquired) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
