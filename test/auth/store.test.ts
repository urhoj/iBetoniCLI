import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, endpointKey, type CredentialsProfile } from "../../src/auth/store.js";

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

describe("store impersonation + remove", () => {
  let dir: string;
  let path: string;
  const base: CredentialsProfile = {
    jwt: "j", refreshToken: "r", issuedAt: "i", expiresAt: "e",
    personId: 1, ownerAsiakasId: 2, ownerAsiakasName: "n", endpoint: "https://x",
  };

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ibstore-")); path = join(dir, "credentials.json"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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

  test("remove resets activeProfile to 'default' when the removed profile was active", async () => {
    const s = createStore(path);
    await s.save(base, "_impersonator");
    // activeProfile is now "_impersonator"; no "default" profile exists
    await s.remove("_impersonator");
    const raw = JSON.parse(await readFile(path, "utf8")) as { activeProfile: string };
    expect(raw.activeProfile).toBe("default");
  });

  // save/remove read through the module's own file cache, but must NOT inherit
  // load()'s "a corrupt file throws" contract — they swallow it, as they always have.
  test("save() overwrites a corrupt file instead of throwing", async () => {
    await writeFile(path, "{ not json", "utf8");
    const s = createStore(path);
    await expect(s.save(base)).resolves.toBeUndefined();
    expect(await s.load()).toMatchObject({ jwt: "j" });
  });

  test("remove() is a no-op on a corrupt file (does not throw, does not rewrite)", async () => {
    await writeFile(path, "{ not json", "utf8");
    const s = createStore(path);
    await expect(s.remove("default")).resolves.toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  test("remove() is a no-op when the file does not exist", async () => {
    const s = createStore(path);
    await expect(s.remove("default")).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});

// fb#855: one session PER ENDPOINT. `profiles.default` is the active session;
// every other endpoint's session is parked under its host key. A login parks
// the previous endpoint's session instead of replacing it, a refresh under
// `--endpoint <other>` never hijacks the default, and each endpoint's session
// lives in exactly one slot.
describe("credentials store — per-endpoint sessions (fb#855)", () => {
  let dir: string;
  let path: string;
  const prod: CredentialsProfile = {
    jwt: "eyJprod", refreshToken: "rp", issuedAt: "i", expiresAt: "e",
    personId: 1, ownerAsiakasId: 8, ownerAsiakasName: "Kalle Urho Oy", endpoint: "https://api.ibetoni.fi",
  };
  const local: CredentialsProfile = { ...prod, jwt: "eyJlocal", refreshToken: "rl", endpoint: "http://127.0.0.1:8080" };

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ibstore855-")); path = join(dir, "credentials.json"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("endpointKey folds scheme, case, path and trailing slash — host[:port] is the identity", () => {
    expect(endpointKey("https://API.ibetoni.fi/")).toBe("api.ibetoni.fi");
    expect(endpointKey("http://127.0.0.1:8080/api")).toBe("127.0.0.1:8080");
    expect(endpointKey("not a url")).toBe("not a url");
  });

  test("a login (activate) parks the previous endpoint's session instead of replacing it", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save(local, undefined, { activate: true });
    expect((await s.load())?.jwt).toBe("eyJlocal"); // the new login is active
    expect((await s.loadFor("https://api.ibetoni.fi"))?.jwt).toBe("eyJprod"); // the old one survives, parked
    expect((await s.loadFor("http://127.0.0.1:8080"))?.jwt).toBe("eyJlocal");
    expect((await s.sessions()).map((x) => [endpointKey(x.endpoint), x.active])).toEqual([
      ["127.0.0.1:8080", true],
      ["api.ibetoni.fi", false],
    ]);
  });

  test("a save for another endpoint WITHOUT activate is parked — the default is never hijacked by a refresh", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save(local); // what refreshAndPersistSession does under --endpoint <local>
    expect((await s.load())?.jwt).toBe("eyJprod");
    expect((await s.loadFor("http://127.0.0.1:8080"))?.jwt).toBe("eyJlocal");
  });

  test("a save for the ACTIVE endpoint replaces the active session in place", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save({ ...prod, jwt: "eyJrotated" });
    expect((await s.load())?.jwt).toBe("eyJrotated");
    expect(await s.sessions()).toHaveLength(1);
  });

  test("activating a parked endpoint leaves exactly one slot per endpoint", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save(local);
    await s.save({ ...local, jwt: "eyJlocal2" }, undefined, { activate: true });
    const raw = JSON.parse(await readFile(path, "utf8")) as { profiles: Record<string, CredentialsProfile> };
    expect(Object.keys(raw.profiles).sort()).toEqual(["api.ibetoni.fi", "default"]);
    expect(raw.profiles.default.jwt).toBe("eyJlocal2");
  });

  test("loadFor is null for an endpoint with no session, even when another is active — never the active token", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    expect(await s.loadFor("http://127.0.0.1:8080")).toBeNull();
  });

  test("a legacy file holding only `default` reads as that endpoint's session", async () => {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, profiles: { default: prod }, activeProfile: "default" }));
    const s = createStore(path);
    expect((await s.loadFor("https://api.ibetoni.fi/"))?.jwt).toBe("eyJprod");
    expect(await s.loadFor("http://127.0.0.1:8080")).toBeNull();
  });

  test("removeEndpoint forgets one session, keeps the rest, and deletes the file with the last", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save(local);
    await s.removeEndpoint("http://127.0.0.1:8080");
    expect(await s.loadFor("http://127.0.0.1:8080")).toBeNull();
    expect((await s.load())?.jwt).toBe("eyJprod");
    await s.removeEndpoint("https://api.ibetoni.fi");
    expect(existsSync(path)).toBe(false);
  });

  test("removeEndpoint of the ACTIVE session leaves a parked one in place (no active until the next login)", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save(local);
    await s.removeEndpoint("https://api.ibetoni.fi");
    expect(await s.load()).toBeNull();
    expect((await s.loadFor("http://127.0.0.1:8080"))?.jwt).toBe("eyJlocal");
  });

  test("sessions() excludes internal stashes (underscore-prefixed profiles)", async () => {
    const s = createStore(path);
    await s.save(prod, undefined, { activate: true });
    await s.save(prod, "_impersonator");
    expect(await s.sessions()).toHaveLength(1);
  });
});
