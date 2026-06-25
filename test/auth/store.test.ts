import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type CredentialsProfile } from "../../src/auth/store.js";

describe("credentials store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("save() then load() round-trips a profile", async () => {
    const store = createStore(join(dir, "credentials.json"));
    await store.save({
      jwt: "eyJtest",
      refreshToken: "rt_test",
      issuedAt: "2026-05-28T10:00:00Z",
      expiresAt: "2026-06-04T10:00:00Z",
      personId: 42,
      ownerAsiakasId: 1349,
      ownerAsiakasName: "Test Oy",
      endpoint: "https://api.ibetoni.fi",
    });
    const loaded = await store.load();
    expect(loaded?.jwt).toBe("eyJtest");
    expect(loaded?.personId).toBe(42);
    expect(loaded?.ownerAsiakasId).toBe(1349);
  });

  test("load() returns null when file does not exist", async () => {
    const store = createStore(join(dir, "credentials.json"));
    expect(await store.load()).toBeNull();
  });

  test("clear() deletes the file", async () => {
    const file = join(dir, "credentials.json");
    const store = createStore(file);
    await store.save({
      jwt: "x",
      refreshToken: "y",
      issuedAt: "",
      expiresAt: "",
      personId: 1,
      ownerAsiakasId: 1,
      ownerAsiakasName: "",
      endpoint: "",
    });
    expect(existsSync(file)).toBe(true);
    await store.clear();
    expect(existsSync(file)).toBe(false);
  });

  test("save() writes file with 0600 permissions on POSIX (existing)", async () => {
    if (process.platform === "win32") return; // skip on Windows; ACL is owner-only by file inheritance
    const file = join(dir, "credentials.json");
    const store = createStore(file);
    await store.save({
      jwt: "x",
      refreshToken: "y",
      issuedAt: "",
      expiresAt: "",
      personId: 1,
      ownerAsiakasId: 1,
      ownerAsiakasName: "",
      endpoint: "",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

{
  let dir: string;
  let path: string;
  const base: CredentialsProfile = {
    jwt: "j", refreshToken: "r", issuedAt: "i", expiresAt: "e",
    personId: 1, ownerAsiakasId: 2, ownerAsiakasName: "n", endpoint: "https://x",
  };

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ibstore-")); path = join(dir, "credentials.json"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  describe("store impersonation + remove", () => {
    test("persists and reads back the impersonation marker", async () => {
      const s = createStore(path);
      await s.save({ ...base, impersonation: { actorPersonId: 10, sessionId: "abc" } });
      const loaded = await s.load();
      expect(loaded?.impersonation).toEqual({ actorPersonId: 10, sessionId: "abc" });
    });

    test("remove deletes one profile, leaving others", async () => {
      const s = createStore(path);
      await s.save(base, "_impersonator");
      await s.save(base, "default");
      await s.remove("_impersonator");
      expect(await s.load("_impersonator")).toBeNull();
      expect(await s.load("default")).not.toBeNull();
    });
  });
}
