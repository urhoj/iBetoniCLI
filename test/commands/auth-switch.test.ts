/**
 * fb#1751: `ib auth switch 27` (and its alias `ib company switch 27`) take the
 * target asiakasId positionally OR as `--to` — the dual-target pattern every
 * other id-taking command follows. Before this the command was flag-only and
 * a caller passing through an id from `ib company list` spent a call on
 * "missing required flag: --to".
 *
 * Driven through the real command tree (not `runArgv`) for the same reason as
 * auth-impersonate.test.ts: the embedded context refuses persisted switches.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProgram, enableParserThrow, handleParseRejection } from "../../src/program.js";
import { captureActionError } from "../helpers/stderr.js";

const runPersistedSwitch = vi.fn(async (to: number, _readOnly: boolean) => ({
  ok: true as const,
  activeCompany: { asiakasId: to, name: "Mock Oy" },
}));

vi.mock("../../src/auth/switch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auth/switch.js")>()),
  runPersistedSwitch: (to: number, ro: boolean) => runPersistedSwitch(to, ro),
}));

async function parse(argv: string[]) {
  const program = await buildProgram(argv);
  const hooks = enableParserThrow(program);
  await program.parseAsync(["node", "ib", ...argv]).catch((err) => handleParseRejection(err, hooks));
}

describe("ib auth switch / ib company switch — positional or --to", () => {
  let out: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    runPersistedSwitch.mockClear();
    out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => out.mockRestore());

  test.each([
    ["auth", "positional"],
    ["auth", "flag"],
    ["company", "positional"],
    ["company", "flag"],
  ])("ib %s switch — %s form switches to the id", async (group, form) => {
    const tail = form === "flag" ? ["--to", "27"] : ["27"];
    await parse([group, "switch", ...tail]);
    expect(runPersistedSwitch).toHaveBeenCalledWith(27, false);
  });

  test("both forms together agree → one switch", async () => {
    await parse(["auth", "switch", "27", "--to", "27"]);
    expect(runPersistedSwitch).toHaveBeenCalledWith(27, false);
  });

  test("positional and --to differ → exit 4, no switch", async () => {
    const { exitCode, envelope } = await captureActionError(() =>
      parse(["auth", "switch", "27", "--to", "28"])
    );
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/differ/);
    expect(runPersistedSwitch).not.toHaveBeenCalled();
  });

  test("neither form → exit 4 naming both spellings", async () => {
    const { exitCode, envelope } = await captureActionError(() => parse(["auth", "switch"]));
    expect(exitCode).toBe(4);
    expect(String(envelope.error)).toMatch(/<asiakasId> positionally or via --to/);
    expect(runPersistedSwitch).not.toHaveBeenCalled();
  });

  test("a non-integer positional → exit 4, no switch", async () => {
    const { exitCode } = await captureActionError(() => parse(["company", "switch", "abc"]));
    expect(exitCode).toBe(4);
    expect(runPersistedSwitch).not.toHaveBeenCalled();
  });
});
