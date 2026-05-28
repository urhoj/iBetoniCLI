import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuth } from "../../src/auth/resolve.js";

describe("resolveAuth", () => {
  let dir: string;
  let origEnv: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-resolve-"));
    origEnv = process.env.IB_TOKEN;
    delete process.env.IB_TOKEN;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origEnv !== undefined) process.env.IB_TOKEN = origEnv;
  });

  test("returns IB_TOKEN-derived auth when env var is set", async () => {
    process.env.IB_TOKEN = "eyJtest"; // not a real JWT but the resolver just stores it
    const auth = await resolveAuth({ credentialsPath: join(dir, "missing.json") });
    expect(auth).not.toBeNull();
    expect(auth!.token).toBe("eyJtest");
    expect(auth!.source).toBe("env");
    expect(auth!.refreshable).toBe(false);
  });

  test("falls back to credentials file when IB_TOKEN absent", async () => {
    const { createStore } = await import("../../src/auth/store.js");
    const file = join(dir, "credentials.json");
    await createStore(file).save({
      jwt: "file_jwt",
      refreshToken: "rt",
      issuedAt: "",
      expiresAt: "",
      personId: 1,
      ownerAsiakasId: 1,
      ownerAsiakasName: "X",
      endpoint: "https://api.example.com",
    });
    const auth = await resolveAuth({ credentialsPath: file });
    expect(auth).not.toBeNull();
    expect(auth!.token).toBe("file_jwt");
    expect(auth!.source).toBe("file");
    expect(auth!.refreshable).toBe(true);
  });

  test("returns null when neither is present", async () => {
    expect(await resolveAuth({ credentialsPath: join(dir, "missing.json") })).toBeNull();
  });
});
