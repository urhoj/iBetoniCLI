import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFriction, frictionPath, truncateMessage } from "../src/friction.js";
import { CliError } from "../src/api/errors.js";
import { setActiveCommandErrors, writeError } from "../src/output/json.js";
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

/**
 * The whole log, or "" before anything has been written. ENOENT-tolerant so a
 * single-test run (`vitest -t …`) does not depend on an earlier test having
 * created the file.
 */
function read(): string {
  try {
    return readFileSync(frictionPath(), "utf8");
  } catch {
    return "";
  }
}

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
  // them, so every entry records who captured it. Each harness exports its
  // session id under its own name; stamping only the Claude var left every
  // Qwen/Codex capture unclaimed, and nothing ever drained those rows.
  describe("session ownership stamp (sid)", () => {
    const SID_ENVS = [
      "CLAUDE_CODE_SESSION_ID",
      "QWEN_CODE_SESSION_ID",
      "CODEX_SESSION_ID",
    ] as const;
    const saved = new Map<string, string | undefined>();
    beforeAll(() => {
      for (const name of SID_ENVS) {
        saved.set(name, process.env[name]);
        delete process.env[name]; // isolate from the runner's own harness
      }
    });
    afterAll(() => {
      for (const name of SID_ENVS) {
        const v = saved.get(name);
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
      }
    });

    test("stamps the harness session id when one is exported", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "sess-abc-123";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBe("sess-abc-123");
      delete process.env.CLAUDE_CODE_SESSION_ID;
    });

    test("stamps the Qwen Code session id when no Claude one is set", () => {
      process.env.QWEN_CODE_SESSION_ID = "qwen-sess-1";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBe("qwen-sess-1");
      delete process.env.QWEN_CODE_SESSION_ID;
    });

    test("stamps the Codex session id as the last fallback", () => {
      process.env.CODEX_SESSION_ID = "codex-sess-1";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBe("codex-sess-1");
      delete process.env.CODEX_SESSION_ID;
    });

    test("the Claude id wins when several harness ids are set", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "cc-1";
      process.env.QWEN_CODE_SESSION_ID = "qw-1";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBe("cc-1");
      delete process.env.CLAUDE_CODE_SESSION_ID;
      delete process.env.QWEN_CODE_SESSION_ID;
    });

    test("stamps null outside an agent session (shell / cron), never a fake owner", () => {
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBeNull();
    });

    test("an empty session id is recorded as null, not an empty-string owner", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "";
      recordFriction(new Error("boom"), 1);
      expect(lastEntry().sid).toBeNull();
      delete process.env.CLAUDE_CODE_SESSION_ID;
    });
  });

  // Unclaimed rows (sid: null) have no drain — no gate ever fires for a plain
  // shell, a cron routine, or a harness without a stop hook — and claimed rows
  // of a dead session are foreign to every other session with no guaranteed
  // release (some gates adopt them after a quiet period, fb#885 — but a gate
  // need not, and standalone betonicli has none). Both classes expire at
  // capture time instead of accumulating forever (fb#887).
  describe("age-out of undrainable rows", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

    function seed(rows: Record<string, unknown>[]): void {
      writeFileSync(
        frictionPath(),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        { mode: 0o600 }
      );
    }
    function messages(): string[] {
      return readFileSync(frictionPath(), "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as Record<string, unknown>).message as string);
    }
    const row = (message: string, extra: Record<string, unknown>) => ({
      argv: message,
      exitCode: 1,
      statusCode: 0,
      code: null,
      message,
      ...extra,
    });

    test("an unclaimed row older than 7 days is dropped on the next write", () => {
      seed([
        row("old-unclaimed", { ts: iso(8 * DAY), sid: null }),
        row("fresh-unclaimed", { ts: iso(1 * DAY), sid: null }),
      ]);
      recordFriction(new Error("trigger"), 1);
      expect(messages()).toEqual(["fresh-unclaimed", "trigger"]);
    });

    test("the pre-rename `at` field is honored too (logged backlog rows)", () => {
      seed([row("old-at-row", { at: iso(8 * DAY), sid: null })]);
      recordFriction(new Error("trigger"), 1);
      expect(messages()).toEqual(["trigger"]);
    });

    test("claimed rows survive past the unclaimed TTL — their own gate drains them", () => {
      seed([row("claimed-old", { ts: iso(20 * DAY), sid: "sess-live" })]);
      recordFriction(new Error("trigger"), 1);
      expect(messages()).toContain("claimed-old");
    });

    test("legacy rows (no sid key) survive the unclaimed TTL — the gate adopts them", () => {
      seed([row("legacy-row", { ts: iso(20 * DAY) })]);
      recordFriction(new Error("trigger"), 1);
      expect(messages()).toContain("legacy-row");
    });

    test("nothing outlives the hard 30-day cap, claimed or not", () => {
      seed([
        row("dead-session", { ts: iso(31 * DAY), sid: "sess-dead" }),
        row("ancient", { ts: iso(40 * DAY), sid: null }),
        row("young", { ts: iso(1 * DAY), sid: "sess-live" }),
      ]);
      recordFriction(new Error("trigger"), 1);
      expect(messages()).toEqual(["young", "trigger"]);
    });

    test("a row with no parseable timestamp is kept, never silently destroyed", () => {
      seed([row("no-ts", { ts: "not-a-date", sid: null })]);
      recordFriction(new Error("trigger"), 1);
      expect(messages()).toContain("no-ts");
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

  // fb#877: a bare slice(0, 400) stored a silently-cut prefix that read as the
  // complete message — the failure mode fb#811 fixed in the stop-gate one layer
  // down. The cut must announce itself.
  describe("message truncation carries a marker (#877)", () => {
    test("a message over the cap is cut on a word boundary and marked", () => {
      const long = ("word ".repeat(120)).trim(); // 599 chars
      const out = truncateMessage(long);
      expect(out.endsWith("… [truncated]")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(400 + "… [truncated]".length + 1);
      expect(out).not.toContain("wor …"); // cut lands between words, not inside one
    });

    test("a message at or under the cap is unchanged — no marker", () => {
      const exact = "x".repeat(400);
      expect(truncateMessage(exact)).toBe(exact);
      expect(truncateMessage("short")).toBe("short");
    });

    test("no nearby space still cuts hard, marker attached", () => {
      const unbroken = "y".repeat(500);
      const out = truncateMessage(unbroken);
      expect(out).toBe("y".repeat(400) + " … [truncated]");
    });

    test("recordFriction stores the marked message, not a silent prefix", () => {
      recordFriction(new Error("long ".repeat(200)), 1);
      expect(String(lastEntry().message)).toContain("… [truncated]");
    });
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
      const hooks = enableParserThrow(program);
      // `view`, not `show` — `show` became a real alias of `get` (fb#373), so it
      // no longer errors; `view` still exercises the same verb-synonym hint.
      await program
        .parseAsync(["node", "ib", "dev", "feedback", "view", "273"])
        .catch((err) => handleParseRejection(err, hooks));
      const e = lastEntry();
      expect(e.exitCode).toBe(4);
      expect(String(e.message)).toContain('unknown command "view" under `ib dev feedback`');
      expect(String(e.message)).toContain("Did you mean `ib dev feedback get`?");
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});

// fb#579: `ib betoni laatu get 2` exits 5 with the command's OWN remedy — that
// is evidence the command works, not friction. Capturing it blocked the stop
// gate and cost a triage round to reach the conclusion the gate's instructions
// already prescribe ("skip expected 404s").
describe("anticipated not-found is not friction (#579)", () => {
  test("exit 5 WITH a command-owned remedy is not captured", () => {
    const before = read();
    recordFriction(
      new CliError("Grade not found in this supplier's catalogue: 2", 404, null, 5),
      undefined,
      "Grade not found — list the catalogue with `ib betoni laatu list`",
      true
    );
    expect(read()).toBe(before);
  });

  test("exit 5 WITHOUT one is still captured (wrong path / undeployed route)", () => {
    recordFriction(new CliError("Route not found", 404, null, 5), undefined, "route not found — not deployed");
    expect(lastEntry().exitCode).toBe(5);
    expect(String(lastEntry().message)).toContain("not deployed");
  });

  test("the skip is exit-5 ONLY — a curated 4 or 6 still captures", () => {
    recordFriction(new CliError("bad flag", 400, null, 4), undefined, "curated exit 4", true);
    expect(lastEntry().message).toBe("curated exit 4");
    recordFriction(new CliError("boom", 500, null, 6), undefined, "curated exit 6", true);
    expect(lastEntry().message).toBe("curated exit 6");
  });
});

// fb#720: a 409 claim conflict on `ib dev feedback claim` is a normal
// concurrency outcome the CLI already answers (holder, expiry, remedy) — not
// a caller mistake. Scoped to that exact message, not every curated 409 (most
// others — jerry offers, message threads, "already closed" on this same
// command — ARE genuine wrong-state mistakes worth keeping as friction).
describe("claim conflict (409) is not friction (#720)", () => {
  test("a curated 409 'is claimed by' is not captured", () => {
    const before = read();
    recordFriction(
      new CliError("Feedback 708 is claimed by 3eec3e until 2026-08-18T15:08:47.819Z", 409, null, 4),
      undefined,
      "Feedback 708 is claimed by 3eec3e until 2026-08-18T15:08:47.819Z — pick another item with `ib dev feedback list --unclaimed`, or pass --steal to take it anyway",
      true
    );
    expect(read()).toBe(before);
  });

  test("an UNcurated 409 'is claimed by' is still captured (no command-owned remedy matched)", () => {
    recordFriction(new CliError("Feedback 708 is claimed by 3eec3e", 409, null, 4), undefined, "generic 409", false);
    expect(lastEntry().message).toBe("generic 409");
  });

  test("a different curated 409 on the same command ('already closed') still captures", () => {
    recordFriction(
      new CliError("Feedback 42 is already closed (applied)", 409, null, 4),
      undefined,
      "already closed",
      true
    );
    expect(lastEntry().message).toBe("already closed");
  });

  test("a curated 409 on a DIFFERENT command (business-state conflict) still captures", () => {
    recordFriction(new CliError("Offer not in draft / not owned", 409, null, 4), undefined, "not a draft", true);
    expect(lastEntry().message).toBe("not a draft");
  });
});

// The unit above proves recordFriction obeys the flag; this proves the CALLER
// passes it. writeError is the funnel every command error goes through, so a
// correct helper wired to nothing would leave the bug fully live.
describe("writeError → friction wiring (#579)", () => {
  const laatuSpec = [
    {
      http: 404,
      exit: 5,
      meaning: "Grade not found",
      remedy: "list the catalogue with `ib betoni laatu list`",
    },
  ];

  /** Run `writeError` with a command's ERRORS rows active, stderr muted. */
  function underCommand(rows: unknown, fn: () => void): void {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      setActiveCommandErrors(rows as never);
      fn();
    } finally {
      setActiveCommandErrors(null);
      stderrSpy.mockRestore();
    }
  }

  // THE REPORTED CASE, in its real shape. `betoni laatu get` throws
  // `CliError(msg, 0, null, 5, remedy)` — statusCode 0 with the remedy on the
  // ERROR, so it resolves as source "error", not "spec". The http-404 tests
  // below exercise a different (also real) route to the same skip; without this
  // one, narrowing the rule to `source === "spec"` would still look green.
  test("the fb#579 case itself — exit 5 with a throw-site remedy — is not logged", () => {
    underCommand(laatuSpec, () => {
      const before = read();
      writeError(
        new CliError(
          "Grade not found in this supplier's catalogue: 2",
          0,
          null,
          5,
          "list the catalogue with `ib betoni laatu list`; a grade owned by ANOTHER supplier is not visible here"
        )
      );
      expect(read()).toBe(before);
    });
  });

  test("a 404 answered by the command's own ERRORS row is not logged", () => {
    underCommand(laatuSpec, () => {
      const before = read();
      writeError(new CliError("Grade not found in this supplier's catalogue: 2", 404, null, 5));
      expect(read()).toBe(before);
    });
  });

  test("an undeployed-route 404 IS logged even while that ERRORS row is active", () => {
    underCommand(laatuSpec, () => {
      writeError(new CliError("Route not found", 404, { code: "ROUTE_NOT_FOUND" }, 5));
      const e = lastEntry();
      expect(e.exitCode).toBe(5);
      expect(String(e.message)).toMatch(/not deployed/i);
    });
  });
});
