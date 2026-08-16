import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  assertNoEatenEmptyString,
  buildProgram,
  enableParserThrow,
  handleParseRejection,
} from "../src/program.js";
import { CliError } from "../src/api/errors.js";

/**
 * Guards the eaten-empty-string detector (fb#634).
 *
 * Windows PowerShell 5.1 DROPS an empty-string argument to a native exe, so the
 * documented clear syntax `--email ""` arrives as `--email <next-token>`.
 *
 * The detector only has to cover the SILENT outcome, and which outcome you get
 * depends on the next token — verified against the real CLI, not assumed:
 *   - a ROOT global (--pretty/--endpoint): Commander refuses to consume a known
 *     option as an option-argument and errors "argument missing". Already loud,
 *     and unreachable here, which is why no test asserts it.
 *   - a stranded positional: excess-arguments error. Already loud.
 *   - a LOCAL flag or a bare word: consumed as the value, nothing fails. This is
 *     the one that needs catching.
 *
 * These tests pin the catch and — just as important — the cases that must stay
 * legal, since a false positive here makes a legitimate value unpassable.
 */

// ─── 1. unit: the detector over a real (tiny) Commander tree ─────────────────

/**
 * Parse argv through a real Commander tree and hand back the root + the leaf the
 * action dispatched to. Real Command objects rather than fakes: the detector
 * reads `rawArgs`, `options[].long/short/attributeName()` and `opts()`, so a
 * hand-rolled stand-in would be testing the stand-in.
 */
function parseFake(argv: string[]): { root: Command; leaf: Command } {
  const root = new Command();
  root.exitOverride();
  root.option("--pretty").option("--endpoint <url>");
  let leaf: Command | undefined;
  root
    .command("set")
    .exitOverride()
    .option("--email <email>")
    .option("--reason <reason>")
    .option("--dry-run")
    .option("--asiakas <id>", "", Number)
    .action((_opts, cmd: Command) => {
      leaf = cmd;
    });
  root.parse(["node", "ib", ...argv]);
  if (!leaf) throw new Error("no leaf dispatched");
  return { root, leaf };
}

/** Run the detector, returning the CliError it threw or null when it allowed the argv. */
function detect(argv: string[]): CliError | null {
  const { root, leaf } = parseFake(argv);
  try {
    assertNoEatenEmptyString(root, leaf);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
}

describe("assertNoEatenEmptyString", () => {
  test("the SILENT shape is refused: a flag whose value is a sibling flag name", () => {
    // `--asiakas 1380 --email "" --dry-run` after PowerShell ate the empty string.
    const err = detect(["set", "--asiakas", "1380", "--email", "--dry-run"]);
    expect(err).not.toBeNull();
    expect(err!.exitCode).toBe(4);
    expect(err!.statusCode).toBe(0); // client-origin
    expect(err!.message).toContain("--email");
    expect(err!.message).toContain("--dry-run");
    // The remedy must name the equals form, which is the whole point.
    expect(err!.message).toContain("--email=");
    expect(err!.message).toContain("ib help shell-quoting");
  });

  test("a stolen --reason is caught — the worst case, since it also eats --dry-run", () => {
    // Both halves are silent: the audit reason becomes a flag name AND the
    // rehearsal the caller asked for turns into a real write.
    const err = detect(["set", "--email", "a@b.fi", "--reason", "--dry-run"]);
    expect(err).not.toBeNull();
    expect(err!.message).toContain("--reason=");
    expect(err!.message).toContain("--dry-run");
  });

  test("the equals form is the remedy, and parses to an empty string", () => {
    const { leaf } = parseFake(["set", "--email="]);
    expect(leaf.opts().email).toBe("");
    expect(detect(["set", "--email="])).toBeNull();
  });

  test("the equals form also passes a literal that LOOKS like a flag", () => {
    // The escape hatch: `--email=--dry-run` is an explicit instruction, so the
    // adjacency check must not fire on it even though the value is a flag name.
    const { leaf } = parseFake(["set", "--email=--dry-run"]);
    expect(leaf.opts().email).toBe("--dry-run");
    expect(detect(["set", "--email=--dry-run"])).toBeNull();
  });

  test("a value that merely STARTS with -- is not a flag name, so it is allowed", () => {
    // Narrowness check: only an EXACT option-name match may fire, otherwise
    // ordinary prose beginning with a dash would become unpassable.
    expect(detect(["set", "--reason", "--not-a-real-flag"])).toBeNull();
    expect(detect(["set", "--reason", "-- leading dashes in prose"])).toBeNull();
  });

  test("ordinary values are untouched", () => {
    expect(detect(["set", "--email", "a@b.fi", "--asiakas", "1380"])).toBeNull();
    expect(detect(["set", "--asiakas", "1380"])).toBeNull();
  });

  test("no rawArgs (a direct action() call) disables the guard rather than throwing", () => {
    const { leaf } = parseFake(["set", "--email", "--dry-run"]);
    const bare = new Command(); // never parsed → no rawArgs
    expect(() => assertNoEatenEmptyString(bare, leaf)).not.toThrow();
  });
});

// ─── 2. integration: through the real command tree ───────────────────────────

describe("eaten empty string through the real program", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: typeof process.exitCode;

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

  /**
   * The detector throws from a preAction hook, so the command's action body —
   * and its getClient() — never runs. No network, no auth needed.
   *
   * `buildProgram(argv)` rather than a bare `buildProgram()`: the argv is a
   * registration HINT, so only the `jerry` domain module loads instead of all
   * ~40. These tests only ever address jerry paths, and the full tree made this
   * a third heavy buildProgram file, which was enough to tip a shared vitest
   * worker over and surface as "Worker exited unexpectedly" in the full run.
   */
  async function run(argv: string[]): Promise<Record<string, unknown>> {
    const program = await buildProgram(argv);
    const hooks = enableParserThrow(program);
    await program
      .parseAsync(["node", "ib", ...argv])
      .catch((err) => handleParseRejection(err, hooks));
    return JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
  }

  test("jerry provider-settings set --email swallowing --dry-run exits 4 with the remedy", async () => {
    const parsed = await run([
      "jerry",
      "provider-settings",
      "set",
      "--asiakas",
      "1380",
      "--email",
      "--dry-run",
    ]);
    expect(process.exitCode).toBe(4);
    expect(String(parsed.error)).toContain("--email=");
    expect(String(parsed.error)).toContain("--dry-run");
  });

  test("a stolen --reason reports the EATEN value, not a missing --reason", async () => {
    // Ordering guard: enforceSpecReasonPolicy would see --reason as satisfied
    // (its value is the string "--dry-run") and wave the write through, so the
    // eaten-string check has to run first or this misreports entirely.
    const parsed = await run([
      "jerry",
      "provider-settings",
      "set",
      "--asiakas",
      "1380",
      "--reason",
      "--dry-run",
    ]);
    expect(process.exitCode).toBe(4);
    expect(String(parsed.error)).toContain("--reason=");
    expect(String(parsed.error)).not.toContain("Missing required flag");
  });
});
