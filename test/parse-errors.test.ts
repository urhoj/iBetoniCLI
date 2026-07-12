import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildProgram,
  enableParserThrow,
  handleParseRejection,
} from "../src/program.js";
import { CliError } from "../src/api/errors.js";
import { runArgv } from "../src/runArgv.js";

/**
 * Usage errors are emitted as the standard JSON envelope (code USAGE, exit 4)
 * via enableParserThrow + handleParseRejection — the parser never calls
 * process.exit and never prints plain text for errors (feedback #24).
 */
describe("parser errors → JSON envelope", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: number | string | undefined;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    process.exitCode = prevExitCode;
  });

  async function run(argv: string[]): Promise<void> {
    const program = buildProgram();
    const { parserText, erroringCommand } = enableParserThrow(program);
    await program
      .parseAsync(["node", "ib", ...argv])
      .catch((err) => handleParseRejection(err, parserText, erroringCommand));
  }

  function lastStderrJson(): Record<string, unknown> {
    const line = String(stderrSpy.mock.calls.at(-1)![0]);
    return JSON.parse(line);
  }

  test("unknown command → USAGE envelope, exit 4", async () => {
    await run(["nosuchcommand"]);
    const parsed = lastStderrJson();
    expect(parsed.code).toBe("USAGE");
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/nosuchcommand/);
    expect(String(parsed.hint)).toMatch(/--help/);
    expect(process.exitCode).toBe(4);
  });

  test("missing required option → USAGE envelope, exit 4", async () => {
    await run(["customer", "person", "add", "--person", "1"]);
    const parsed = lastStderrJson();
    expect(parsed.code).toBe("USAGE");
    expect(String(parsed.error)).toMatch(/--asiakas/);
    expect(process.exitCode).toBe(4);
  });

  test("missing required options are reported together", async () => {
    await run(["dev", "changelog", "add", "--repo", "betonicli", "--title", "x"]);
    const parsed = lastStderrJson();
    const error = String(parsed.error);
    expect(parsed.code).toBe("USAGE");
    expect(error).toContain("--type");
    expect(error).toContain("--area");
    // --description is no longer a parser-required option (fb#172: accepted
    // positionally or via --description, resolved in the action → exit 4 there).
    expect(process.exitCode).toBe(4);
  });

  test("unknown flag → USAGE envelope, exit 4", async () => {
    await run(["company", "list", "--nope"]);
    const parsed = lastStderrJson();
    expect(parsed.code).toBe("USAGE");
    expect(String(parsed.error)).toMatch(/--nope/);
    expect(process.exitCode).toBe(4);
  });

  test("--help exits 0 and is NOT an envelope (help text on stdout)", async () => {
    await run(["--help"]);
    expect(process.exitCode).toBe(0);
    // help went to stdout via Commander's writeOut, untouched
    expect(stdoutSpy).toHaveBeenCalled();
    expect(String(stdoutSpy.mock.calls[0][0])).toMatch(/USAGE|Usage/i);
  });

  test("bare group renders its help text (not an envelope), exit 1", async () => {
    await run(["company"]);
    expect(process.exitCode).toBe(1);
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toMatch(/SUBCOMMANDS|Usage/i);
    expect(text).not.toMatch(/"code":"USAGE"/);
  });

  test("a CliError thrown outside an action try lands as envelope + mapped code", () => {
    handleParseRejection(new CliError("guard", 0, null, 3), () => "");
    const parsed = lastStderrJson();
    expect(parsed.error).toBe("guard");
    expect(process.exitCode).toBe(3);
  });

  test("non-Commander, non-CliError stays plain text exit 1", () => {
    handleParseRejection(new Error("boom"), () => "");
    expect(String(stderrSpy.mock.calls.at(-1)![0])).toBe("boom\n");
    expect(process.exitCode).toBe(1);
  });
});

test("unknown legal subcommand → enriched envelope (#1)", async () => {
  const { exitCode, stderr } = await runArgv(["legal", "verison"], {
    token: "",
    endpoint: "https://example.invalid",
  });
  expect(exitCode).toBe(4);
  const env = JSON.parse(stderr);
  expect(env.code).toBe("USAGE");
  expect(env.group).toBe("ib legal");
  expect(env.unknownCommand).toBe("verison");
  expect(env.didYouMean).toBe("versions");
  expect(env.available).toContain("active");
  expect(env.available).not.toContain("save"); // tokenless → standard tier
});
