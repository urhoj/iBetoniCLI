/**
 * fb#1102: `ib auth impersonate`'s "not logged in" remedy must be
 * endpoint-aware, like `auth whoami`/`auth refresh` (fb#1040) — otherwise the
 * prescribed bare `ib auth login` mints a token for the DEFAULT endpoint while
 * impersonation is about to present it against a different --endpoint, a 401.
 *
 * Driven through the real (non-embedded) command tree rather than `runArgv`:
 * `assertPersistedSwitchAllowed` refuses every persisted switch unconditionally
 * under an EMBEDDED context (fb#316), which `runArgv` always sets up — that
 * guard would fire before the code under test ever runs.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, enableParserThrow, handleParseRejection } from "../../src/program.js";
import { captureActionError } from "../helpers/stderr.js";

describe("ib auth impersonate — not-logged-in remedy", () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-impersonate-"));
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  function run(argv: string[]) {
    return captureActionError(async () => {
      const program = await buildProgram(argv);
      const hooks = enableParserThrow(program);
      await program
        .parseAsync(["node", "ib", ...argv])
        .catch((err) => handleParseRejection(err, hooks));
    });
  }

  test("no stored session + --endpoint names that endpoint in the remedy", async () => {
    const { exitCode, envelope } = await run([
      "auth",
      "impersonate",
      "123",
      "--endpoint",
      "http://127.0.0.1:9999",
    ]);
    expect(exitCode).toBe(2);
    expect(String(envelope.error)).toContain("Not logged in at http://127.0.0.1:9999");
    expect(String(envelope.error)).toContain("ib auth login --endpoint http://127.0.0.1:9999");
  });

  test("no stored session, no --endpoint override, keeps the generic remedy", async () => {
    const { exitCode, envelope } = await run(["auth", "impersonate", "123"]);
    expect(exitCode).toBe(2);
    expect(String(envelope.error)).toBe("Not logged in. Run `ib auth login` first.");
  });
});
