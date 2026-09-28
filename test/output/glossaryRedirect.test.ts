import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { glossaryDomainFor, type GlossaryLookup } from "../../src/output/glossaryRedirect.js";
import { buildProgram, enableParserThrow, handleParseRejection } from "../../src/program.js";

const hit = (term: string, ...commands: string[]): GlossaryLookup =>
  async () => ({ term, relatedCommands: commands.map((command) => ({ command })) });

describe("glossaryDomainFor (fb#2044)", () => {
  test("maps a Finnish word to the domain of its first related command", async () => {
    const m = await glossaryDomainFor("asiakas", hit("asiakas", "ib customer", "ib company"), "developer");
    expect(m?.path).toBe("ib customer");
    expect(m?.why).toContain("`asiakas`");
  });

  test("a synonym hit names the canonical term", async () => {
    const m = await glossaryDomainFor("auto", hit("ajoneuvo", "ib vehicle list"), "developer");
    expect(m?.path).toBe("ib vehicle");
    expect(m?.why).toContain("synonym of `ajoneuvo`");
  });

  test("a miss, an error, or no known domain answers nothing", async () => {
    expect(await glossaryDomainFor("foobar", async () => null, "developer")).toBeNull();
    expect(await glossaryDomainFor("foobar", async () => { throw new Error("404"); }, "developer")).toBeNull();
    expect(await glossaryDomainFor("foobar", hit("foobar", "ib nosuchdomain"), "developer")).toBeNull();
  });

  test("never confirms a domain hidden at the caller's tier", async () => {
    expect(await glossaryDomainFor("tehtava", hit("tehtava", "ib task list"), "standard")).toBeNull();
    expect((await glossaryDomainFor("tehtava", hit("tehtava", "ib task list"), "developer"))?.path).toBe("ib task");
  });

  test("a slow backend times out to nothing", async () => {
    vi.useFakeTimers();
    try {
      const pending = glossaryDomainFor("asiakas", () => new Promise(() => {}), "developer");
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unknown root command → glossary redirect", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.exitCode = prevExitCode;
  });

  async function run(argv: string[], glossaryLookup: GlossaryLookup): Promise<Record<string, unknown>> {
    const program = await buildProgram();
    const hooks = enableParserThrow(program);
    await program.parseAsync(["node", "ib", ...argv]).catch((err) => handleParseRejection(err, { ...hooks, glossaryLookup }));
    return JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
  }

  test("`ib asiakas get 8` points at `ib customer get 8`", async () => {
    const env = await run(["asiakas", "get", "8"], hit("asiakas", "ib customer"));
    expect(env.availableElsewhere).toEqual(["ib customer"]);
    expect(String(env.hint)).toContain("`ib customer get 8` does");
    expect(process.exitCode).toBe(4);
  });

  test("not consulted when an offline layer already answered, or for a non-word token", async () => {
    const lookup = vi.fn(hit("x", "ib customer"));
    await run(["grid"], lookup); // ROOT_FEATURE_DOMAINS answers
    await run(["x1"], lookup); // not word-shaped
    expect(lookup).not.toHaveBeenCalled();
  });
});
