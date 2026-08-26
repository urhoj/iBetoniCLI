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
 *
 * The lock directory's mtime doubles as the acquisition's IDENTITY: this
 * process never writes into the dir, so the mtime is fixed at creation, and a
 * different instance at the same path (released and re-acquired by someone
 * else) necessarily carries a different one. Both destructive paths — the
 * stale-break and our own release — compare-and-delete on it, so neither can
 * remove a lock some other process is currently holding (the TOCTOU the
 * fb#884 review found: blindly rm-ing the path could delete a FRESH lock and
 * leave two holders inside the critical section at once).
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

/** Acquired-but-identity-unknowable sentinel (own stat failed after mkdir). */
const OWN_UNSTATABLE = -1;

/**
 * Acquire the lock. Returns the created lock directory's mtime — the identity
 * {@link releaseOwn} compares against — or null when nothing was acquired
 * (the caller proceeds unlocked; see the module doc).
 *
 * EVERY retry path routes through the single deadline+sleep at the bottom of
 * the loop. That is load-bearing: the original ENOENT parent-create branch
 * retried straight from the top, so a parent that could never be created
 * (EACCES/EROFS on HOME, a sandboxed environment) busy-looped forever at full
 * CPU — the exact hard outage this lock's best-effort contract promises not
 * to cause. Same for a persistently failing stat or rm.
 */
async function acquire(lockPath: string, o: Required<FileLockOptions>): Promise<number | null> {
  const deadline = Date.now() + o.capMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      const s = await stat(lockPath).catch(() => null);
      return s ? s.mtimeMs : OWN_UNSTATABLE;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Parent dir missing (first-ever run) — create it and retry.
        await mkdir(dirname(lockPath), { recursive: true }).catch(() => {});
      } else if (code !== "EEXIST") {
        return null; // unexpected fs error — proceed unlocked
      } else {
        const s = await stat(lockPath).catch(() => null);
        if (s && Date.now() - s.mtimeMs > o.staleMs) {
          // Orphaned by a dead holder — break it, but only the exact instance
          // judged stale: re-check identity immediately before the delete, so
          // a lock that was released and re-acquired while we decided is never
          // the one removed. Two waiters may still both rm the SAME stale
          // instance and both retry the mkdir; exactly one wins.
          const s2 = await stat(lockPath).catch(() => null);
          if (s2 && s2.mtimeMs === s.mtimeMs) {
            await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
    }
    if (Date.now() >= deadline) return null; // give up; proceed unlocked
    await sleep(o.pollMs);
  }
}

/**
 * Remove the lock ONLY while it is still the instance this process created.
 * If we held past `staleMs`, a waiter may have broken our lock and someone
 * else acquired a fresh one at the same path — deleting THAT would hand the
 * lock to two holders at once. {@link OWN_UNSTATABLE} releases blind, as the
 * best available behaviour when the identity could not be captured.
 */
async function releaseOwn(lockPath: string, stamp: number): Promise<void> {
  if (stamp !== OWN_UNSTATABLE) {
    const s = await stat(lockPath).catch(() => null);
    if (!s || s.mtimeMs !== stamp) return; // gone, or no longer ours
  }
  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

/**
 * Run `fn` holding the exclusive lock at `lockPath` (a directory created and
 * removed around the call). Never throws for lock reasons: on any acquisition
 * failure `fn` runs unlocked (see module doc). A lock this process did not
 * acquire — or no longer owns — is never removed.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const stamp = await acquire(lockPath, { ...DEFAULTS, ...options });
  try {
    return await fn();
  } finally {
    if (stamp !== null) await releaseOwn(lockPath, stamp);
  }
}
