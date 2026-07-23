import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFriction, frictionPath } from "../src/friction.js";
import { CliError } from "../src/api/errors.js";
import {
  buildProgram,
  enableParserThrow,
  handleParseRejection,
} from "../src/program.js";

// os.homedir() honors $HOME (POSIX) / %USERPROFILE% (Windows) — point it at a
// temp dir so the test can NEVER write to the developer's real ~/.ibetoni log.
const TMP = mkdtempSync(join(tmpdir(), "ib-friction-"));
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeAll(() => {
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.IB_FRICTION_TEST = "1"; // re-enable recordFriction under vitest
});
afterAll(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  delete process.env.IB_FRICTION_TEST;
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function lastEntry(): Record<string, unknown> {
  const lines = readFileSync(frictionPath(), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

describe("recordFriction", () => {
  test("writes under the temp home (guard against polluting the real log)", () => {
    expect(frictionPath().startsWith(TMP)).toBe(true);
  });

  test("appends an entry with exitCode, statusCode, message, ts, argv", () => {
    recordFriction(new CliError("not found", 404, null, 5));
    const e = lastEntry();
    expect(e.exitCode).toBe(5);
    expect(e.statusCode).toBe(404);
    expect(e.message).toBe("not found");
    expect(typeof e.ts).toBe("string");
    expect(typeof e.argv).toBe("string");
  });

  test("honors an explicit exitCode override (parser/USAGE path)", () => {
    recordFriction(new Error("unknown option '--badflag'"), 4);
    expect(lastEntry().exitCode).toBe(4);
  });

  test("caps the ring buffer at 300 entries", () => {
    for (let i = 0; i < 350; i++) recordFriction(new Error("e" + i), 1);
    const lines = readFileSync(frictionPath(), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(300);
  });

  test("a `displayed` override replaces the raw err.message", () => {
    recordFriction(new Error("error: unknown command 'show'"), 4, "shown text with hint");
    expect(lastEntry().message).toBe("shown text with hint");
  });

  // Fidelity contract (fb#275): the friction log must carry what the caller
  // SAW — the enriched envelope with the did-you-mean — not Commander's bare
  // internal message. A groomer reading a bare `unknown command 'show'` filed
  // a request for a show→get hint that already existed (fb#229).
  test("unknown-subcommand parse path records the displayed did-you-mean, not the bare parser message", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prevExitCode = process.exitCode;
    try {
      const program = buildProgram();
      const { parserText, erroringCommand } = enableParserThrow(program);
      await program
        .parseAsync(["node", "ib", "dev", "feedback", "show", "273"])
        .catch((err) => handleParseRejection(err, parserText, erroringCommand));
      const e = lastEntry();
      expect(e.exitCode).toBe(4);
      expect(String(e.message)).toContain('unknown command "show" under `ib dev feedback`');
      expect(String(e.message)).toContain("Did you mean `ib dev feedback get`?");
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});
