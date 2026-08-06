import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
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

  // feedback #312: the log file is machine-global but is drained by a
  // per-session stop gate. Without an owner stamp the draining session
  // mis-attributes foreign rows AND deletes them before their own actor sees
  // them, so every entry records who captured it.
  describe("session ownership stamp (sid)", () => {
    const origSid = process.env.CLAUDE_CODE_SESSION_ID;
    afterAll(() => {
      if (origSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = origSid;
    });

    test("stamps the harness session id when one is exported", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "sess-abc-123";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBe("sess-abc-123");
    });

    test("stamps null outside an agent session (shell / cron), never a fake owner", () => {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBeNull();
    });

    test("an empty session id is recorded as null, not an empty-string owner", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBeNull();
    });
  });

  // feedback #313: a session logged 24 entries that were 8 deliberate probes run
  // three times. Every one exited exactly as designed; signal-to-noise was 0/24.
  describe("deliberate negative-path runs (#313)", () => {
    test("IB_FRICTION_OFF suppresses capture entirely", () => {
      const before = readFileSync(frictionPath(), "utf8");
      for (const v of ["1", "true", "YES"]) {
        process.env.IB_FRICTION_OFF = v;
        recordFriction(new Error("deliberate " + v), 4);
      }
      delete process.env.IB_FRICTION_OFF;
      expect(readFileSync(frictionPath(), "utf8")).toBe(before);
    });

    test("a non-truthy IB_FRICTION_OFF does NOT disable capture (fail-open)", () => {
      process.env.IB_FRICTION_OFF = "0";
      recordFriction(new Error("still recorded"), 4);
      delete process.env.IB_FRICTION_OFF;
      expect(lastEntry().message).toBe("still recorded");
    });

    test("an identical repeat collapses into a count instead of a new row", () => {
      const lineCount = () => readFileSync(frictionPath(), "utf8").trim().split("\n").length;
      recordFriction(new Error("repeat me"), 4);
      const after1 = lineCount();
      recordFriction(new Error("repeat me"), 4);
      recordFriction(new Error("repeat me"), 4);
      expect(lineCount()).toBe(after1); // three probes, one row
      const e = lastEntry();
      expect(e.count).toBe(3);
      // ts stays the FIRST sighting; lastTs records the most recent one.
      expect(String(e.lastTs) >= String(e.ts)).toBe(true);
    });

    test("a DIFFERENT message still gets its own row", () => {
      recordFriction(new Error("distinct A"), 4);
      const n = readFileSync(frictionPath(), "utf8").trim().split("\n").length;
      recordFriction(new Error("distinct B"), 4);
      expect(readFileSync(frictionPath(), "utf8").trim().split("\n").length).toBe(n + 1);
    });

    // fb#312's ownership stamp must survive dedupe: folding across sessions
    // would let one session adopt (and then drain) another's row.
    test("never folds across sessions — a different sid gets its own row", () => {
      const origSid = process.env.CLAUDE_CODE_SESSION_ID;
      try {
        process.env.CLAUDE_CODE_SESSION_ID = "sess-one";
        recordFriction(new Error("shared text"), 4);
        const n = readFileSync(frictionPath(), "utf8").trim().split("\n").length;
        process.env.CLAUDE_CODE_SESSION_ID = "sess-two";
        recordFriction(new Error("shared text"), 4);
        expect(readFileSync(frictionPath(), "utf8").trim().split("\n").length).toBe(n + 1);
        expect(lastEntry().sid).toBe("sess-two");
      } finally {
        if (origSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
        else process.env.CLAUDE_CODE_SESSION_ID = origSid;
      }
    });

    test("an unparseable line is preserved verbatim, never dropped by dedupe", () => {
      writeFileSync(frictionPath(), "not json at all\n", { mode: 0o600 });
      recordFriction(new Error("after garbage"), 4);
      const lines = readFileSync(frictionPath(), "utf8").trim().split("\n");
      expect(lines[0]).toBe("not json at all");
      expect(lines).toHaveLength(2);
    });
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
      const program = await buildProgram();
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
