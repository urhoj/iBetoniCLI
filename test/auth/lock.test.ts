import { describe, test, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../src/auth/lock.js";

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
});
