/**
 * fb#1040: the "Not logged in" failure must prescribe a remedy that actually
 * fixes it — under --endpoint the generic `ib auth login` authenticates the
 * DEFAULT endpoint and leaves the requested one unauthenticated.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notLoggedInMessage, otherSessionsHint } from "../../src/auth/notLoggedIn.js";
import { createStore } from "../../src/auth/store.js";

describe("notLoggedInMessage", () => {
  test("no endpoint keeps the generic remedy", () => {
    expect(notLoggedInMessage()).toBe("Not logged in. Run `ib auth login` first.");
    expect(notLoggedInMessage(null)).toBe("Not logged in. Run `ib auth login` first.");
  });

  test("no endpoint + mentionIbToken keeps the IB_TOKEN alternative", () => {
    expect(notLoggedInMessage(undefined, { mentionIbToken: true })).toBe(
      "Not logged in. Run `ib auth login` first (or set IB_TOKEN)."
    );
  });

  test("an endpoint is named in BOTH the failure and the remedy", () => {
    expect(notLoggedInMessage("http://127.0.0.1:8080")).toBe(
      "Not logged in at http://127.0.0.1:8080. Run `ib auth login --endpoint http://127.0.0.1:8080` first."
    );
  });

  test("an endpoint + mentionIbToken keeps the IB_TOKEN alternative", () => {
    expect(notLoggedInMessage("http://127.0.0.1:8080", { mentionIbToken: true })).toBe(
      "Not logged in at http://127.0.0.1:8080. Run `ib auth login --endpoint http://127.0.0.1:8080` first (or set IB_TOKEN)."
    );
  });
});

describe("otherSessionsHint", () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-notloggedin-"));
    prevHome = process.env.HOME;
    // defaultCredentialsPath reads HOME first (then USERPROFILE) at call time.
    process.env.HOME = dir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = (endpoint: string) => ({
    jwt: "eyJtest",
    refreshToken: "rt_test",
    issuedAt: "2026-05-28T10:00:00Z",
    expiresAt: "2026-06-04T10:00:00Z",
    personId: 42,
    ownerAsiakasId: 8,
    ownerAsiakasName: "Test Oy",
    endpoint,
  });

  test("no endpoint → no hint", async () => {
    expect(await otherSessionsHint(undefined)).toBeUndefined();
    expect(await otherSessionsHint(null)).toBeUndefined();
  });

  test("no stored sessions → no hint", async () => {
    expect(await otherSessionsHint("http://127.0.0.1:8080")).toBeUndefined();
  });

  test("existing sessions are named, and the remedy adds (not replaces)", async () => {
    const store = createStore(join(dir, ".ibetoni", "credentials.json"));
    await store.save(profile("https://api.ibetoni.fi"));
    expect(await otherSessionsHint("http://127.0.0.1:8080")).toBe(
      "sessions are kept per endpoint — you hold api.ibetoni.fi, which stay; `ib auth login --endpoint http://127.0.0.1:8080` adds this one"
    );
  });
});
