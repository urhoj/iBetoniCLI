import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/auth/store.js";

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

  test("save() writes file with 0600 permissions on POSIX", async () => {
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
