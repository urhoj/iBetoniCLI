import { describe, test, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../src/auth/lock.js";

// fb#897: forces mkdir to reject ENOENT for the one test below that needs an
// OS-independent repro of the F1 busy-loop bug — every other test keeps the
// real fs behaviour via importOriginal.
let forceMkdirEnoent = false;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) =>
      forceMkdirEnoent
        ? Promise.reject(Object.assign(new Error("forced ENOENT"), { code: "ENOENT" }))
        : actual.mkdir(...args),
  };
});

const TMP = mkdtempSync(join(tmpdir(), "ib-lock-"));
afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withFileLock (fb#884)", () => {
  test("serializes two concurrent critical sections — no interleaving", async () => {
    const lockPath = join(TMP, "serial.lock");
    const events: string[] = [];
    const section = (name: string) =>
      withFileLock(
        lockPath,
        async () => {
          events.push(`start-${name}`);
          await sleep(50);
          events.push(`end-${name}`);
        },
        { pollMs: 10 }
      );
    await Promise.all([section("A"), section("B")]);
    // Whichever ran first must FINISH before the other starts.
    expect(events).toHaveLength(4);
    expect(events[0].replace("start-", "")).toBe(events[1].replace("end-", ""));
    expect(events[2].replace("start-", "")).toBe(events[3].replace("end-", ""));
  });

  test("the lock is released even when the critical section throws", async () => {
    const lockPath = join(TMP, "throw.lock");
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
    // And a follow-up acquisition succeeds immediately.
    const ran = await withFileLock(lockPath, async () => "ok", { pollMs: 10 });
    expect(ran).toBe("ok");
  });

  test("a stale lock (dead holder) is broken instead of blocking forever", async () => {
    const lockPath = join(TMP, "stale.lock");
    await mkdir(lockPath);
    const past = (Date.now() - 60_000) / 1000;
    await utimes(lockPath, past, past);
    const ran = await withFileLock(lockPath, async () => "ok", {
      pollMs: 10,
      staleMs: 500,
    });
    expect(ran).toBe("ok");
    expect(existsSync(lockPath)).toBe(false); // ours now — removed on release
  });

  test("at the acquisition cap the section still runs, and the FOREIGN lock is left in place", async () => {
    const lockPath = join(TMP, "held.lock");
    await mkdir(lockPath); // fresh mtime — a live foreign holder
    const ran = await withFileLock(lockPath, async () => "ok", {
      pollMs: 20,
      staleMs: 60_000,
      capMs: 200,
    });
    expect(ran).toBe("ok"); // best-effort: never blocks the refresh forever
    expect(existsSync(lockPath)).toBe(true); // not ours — never removed
  });

  test("creates a missing parent directory (first-ever run)", async () => {
    const lockPath = join(TMP, "brand-new-dir", "creds.json.lock");
    const ran = await withFileLock(lockPath, async () => "ok", { pollMs: 10 });
    expect(ran).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  // Review finding F1: the ENOENT parent-create branch used to retry from the
  // TOP of the loop, skipping the deadline and the sleep — a parent that could
  // never be created busy-looped forever at full CPU, the exact hard outage
  // the best-effort contract promises not to cause. Every retry path must
  // route through the deadline.
  //
  // fb#897: this repro is Windows-only — a parent path blocked by a FILE
  // throws ENOENT from fs.mkdir on Windows, but ENOTDIR on POSIX/ubuntu (CI),
  // which routes through lock.ts's unrelated `code !== "EEXIST"` branch and
  // returns immediately, already correct before the fix. So this test alone
  // passes identically against pre-fix and post-fix code on Linux CI — zero
  // regression protection there. Kept as Windows-specific defense-in-depth;
  // the OS-independent guard is the forced-ENOENT test right below it.
  test("an uncreatable parent (path blocked by a FILE) still returns within the cap — never hangs [Windows-only guard]", async () => {
    const blocker = join(TMP, "blocker");
    writeFileSync(blocker, "not a directory");
    const lockPath = join(blocker, "creds.json.lock"); // mkdir can never succeed here
    const t0 = Date.now();
    const ran = await withFileLock(lockPath, async () => "ok", { pollMs: 20, capMs: 300 });
    expect(ran).toBe("ok"); // proceeded unlocked at the cap
    expect(Date.now() - t0).toBeLessThan(5000); // bounded, not a spin/hang
  });

  // fb#897: OS-independent twin of the test above — forces the exact ENOENT
  // code the F1 fix guards against (real Windows fs.mkdir semantics; POSIX's
  // real ENOTDIR never reaches this branch), so it actually fails against the
  // pre-fix "retry from the top" code on every platform, including ubuntu CI.
  test("mkdir persistently rejecting ENOENT still returns within the cap — never hangs (OS-independent)", async () => {
    const lockPath = join(TMP, "forced-enoent-parent", "creds.json.lock");
    forceMkdirEnoent = true;
    try {
      const t0 = Date.now();
      const ran = await withFileLock(lockPath, async () => "ok", { pollMs: 20, capMs: 300 });
      expect(ran).toBe("ok"); // proceeded unlocked at the cap
      expect(Date.now() - t0).toBeLessThan(5000); // bounded, not a spin/hang
    } finally {
      forceMkdirEnoent = false;
    }
  });

  // Review finding F2 (release half): if a waiter stale-broke our lock while we
  // held past staleMs and a third process acquired a FRESH lock at the same
  // path, our release must not delete theirs — that would let two processes
  // into the critical section at once. Identity = the lock dir's mtime,
  // captured at acquire time and compared before every destructive rm.
  test("release removes only its OWN lock instance — a foreign fresh lock at the same path survives", async () => {
    const lockPath = join(TMP, "identity.lock");
    let releaseGate!: () => void;
    const held = new Promise<void>((r) => {
      releaseGate = r;
    });
    const run = withFileLock(
      lockPath,
      async () => {
        await held;
        return "ok";
      },
      { pollMs: 10 }
    );
    while (!existsSync(lockPath)) await sleep(5); // our lock is up
    await sleep(10); // ensure the replacement gets a distinct mtime
    // Simulate the race: someone breaks our lock, a third process acquires.
    rmSync(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    releaseGate();
    expect(await run).toBe("ok");
    expect(existsSync(lockPath)).toBe(true); // the foreign lock was NOT removed
    rmSync(lockPath, { recursive: true, force: true });
  });
});
