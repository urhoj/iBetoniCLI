import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { resolveAuth } from "../../src/auth/resolve.js";
import { CliError } from "../../src/api/errors.js";

function fakeJwt(payload: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

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

  // JWT-SHAPED on purpose: since fb#351 an IB_TOKEN that cannot be a JWT is
  // rejected up front rather than stored (see the shape block below), so the old
  // "eyJtest" placeholder no longer stands in for a real token here.
  test("returns IB_TOKEN-derived auth when env var is set", async () => {
    const token = fakeJwt({ personId: 5, ownerAsiakasId: 1349 });
    process.env.IB_TOKEN = token;
    const auth = await resolveAuth({ credentialsPath: join(dir, "missing.json") });
    expect(auth).not.toBeNull();
    expect(auth!.token).toBe(token);
    expect(auth!.source).toBe("env");
    expect(auth!.refreshable).toBe(false);
    expect(auth!.personId).toBe(5);
    expect(auth!.ownerAsiakasId).toBe(1349);
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

  test("an explicit token wins over IB_TOKEN and the credentials file", async () => {
    process.env.IB_TOKEN = "env_jwt";
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
    const auth = await resolveAuth({ credentialsPath: file, token: "caller_jwt" });
    expect(auth!.token).toBe("caller_jwt");
    expect(auth!.refreshable).toBe(false);
  });

  // An embedded caller that sent NO token must not silently act as the host's
  // session — the empty token stands and the API answers 401.
  test("an explicit EMPTY token does not fall back to the host credentials", async () => {
    process.env.IB_TOKEN = "env_jwt";
    const auth = await resolveAuth({ credentialsPath: join(dir, "missing.json"), token: "" });
    expect(auth!.token).toBe("");
    expect(auth!.refreshable).toBe(false);
  });

  // fb#351: an IB_TOKEN that cannot be a JWT is a VALUE problem (a mis-captured
  // command substitution), not a rejected credential — so it fails fast with a
  // diagnostic instead of a 401 that names the wrong cause.
  test("a captured-stdout IB_TOKEN fails fast as an auth error, naming the value problem", async () => {
    process.env.IB_TOKEN = `✅ DB pool warmed up in 42ms\n${fakeJwt({ personId: 5 })}`;
    const err = await resolveAuth({ credentialsPath: join(dir, "missing.json") }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CliError);
    const cli = err as CliError;
    expect(cli.exitCode).toBe(2); // auth, not the generic 1
    expect(cli.message).toMatch(/IB_TOKEN is not a JWT: segment 1 of 3 contains whitespace/);
    expect(cli.hint).toMatch(/command substitution/);
  });

  // fb#420: SETTING IB_TOKEN is the caller declaring headless intent, so an empty
  // value is a broken minting step — never a request to fall back to interactive
  // credentials. Under the old truthiness check it silently used the credentials
  // file, and any staleness there surfaced as "session unrecoverable, run
  // `ib auth login`": a diagnostic naming the wrong subsystem entirely.
  test("an EMPTY IB_TOKEN fails fast instead of falling back to the credentials file", async () => {
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
    process.env.IB_TOKEN = "";

    const err = await resolveAuth({ credentialsPath: file }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const cli = err as CliError;
    expect(cli.exitCode).toBe(2);
    expect(cli.message).toMatch(/IB_TOKEN is not a JWT: the variable is set but empty/);
    // The remedy must point at the minting command's stderr, NOT at the
    // captured-banner advice — there is no banner to strip when stdout was empty.
    expect(cli.hint).toMatch(/wrote nothing to stdout/);
    expect(cli.hint).not.toMatch(/banner lines included/);
  });

  test("an UNSET IB_TOKEN still falls back to the credentials file", async () => {
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
    delete process.env.IB_TOKEN;

    const auth = await resolveAuth({ credentialsPath: file });
    expect(auth).toMatchObject({ token: "file_jwt", source: "file", refreshable: true });
  });

  // The embedded caller's token comes from the SERVER, so a 401 is the honest
  // answer there — no local guess about how it was set.
  test("an embedded caller's malformed token stays best-effort", async () => {
    const auth = await resolveAuth({
      credentialsPath: join(dir, "missing.json"),
      token: "not-a-jwt",
    });
    expect(auth).toMatchObject({ source: "env", personId: null, ownerAsiakasId: null });
  });
});
