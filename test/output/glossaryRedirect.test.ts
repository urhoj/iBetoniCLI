import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { glossaryDomainFor, glossaryLookupVia, type GlossaryLookup } from "../../src/output/glossaryRedirect.js";
import { buildProgram, enableParserThrow, handleParseRejection } from "../../src/program.js";
import type { ApiClient } from "../../src/api/client.js";

const hit = (term: string, ...commands: string[]): GlossaryLookup =>
  async () => ({ term, relatedCommands: commands.map((command) => ({ command })) });

describe("glossaryDomainFor (fb#2044)", () => {
  test("a related group is suggested as-is", async () => {
    const m = await glossaryDomainFor("asiakas", hit("asiakas", "ib customer", "ib company"), "developer");
    expect(m?.path).toBe("ib customer");
    expect(m?.why).toContain("`asiakas`");
  });

  test("a related leaf yields its parent group; a synonym hit names the canonical term", async () => {
    const m = await glossaryDomainFor("auto", hit("ajoneuvo", "ib vehicle list"), "developer");
    expect(m?.path).toBe("ib vehicle");
    expect(m?.why).toContain("synonym of `ajoneuvo`");
  });

  test("a nested leaf keeps its subgroup, never the bare domain (fb#2058)", async () => {
    const m = await glossaryDomainFor("palaute", hit("palaute", "ib dev feedback create"), "developer");
    expect(m?.path).toBe("ib dev feedback");
  });

  test("a miss, an error, or no known command answers nothing", async () => {
    expect(await glossaryDomainFor("foobar", async () => null, "developer")).toBeNull();
    expect(await glossaryDomainFor("foobar", async () => { throw new Error("404"); }, "developer")).toBeNull();
    expect(await glossaryDomainFor("foobar", hit("foobar", "ib nosuchdomain"), "developer")).toBeNull();
    expect(await glossaryDomainFor("versio", hit("versio", "ib version"), "developer")).toBeNull(); // a root leaf is no group
  });

  test("never confirms a group hidden at the caller's tier", async () => {
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

describe("glossaryLookupVia (fb#2058)", () => {
  test("asks the invocation's own client, term URL-encoded", async () => {
    const get = vi.fn(async () => ({ term: "työmaa" }));
    const lookup = glossaryLookupVia(async () => ({ get }) as unknown as ApiClient);
    await lookup("työmaa");
    expect(get).toHaveBeenCalledWith(`/api/cli/glossary/lookup/${encodeURIComponent("työmaa")}`);
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

  test("a verb the group does not own is not claimed to exist (fb#2058)", async () => {
    const env = await run(["asiakas", "foo"], hit("asiakas", "ib customer"));
    expect(env.availableElsewhere).toEqual(["ib customer"]);
    expect(String(env.hint)).not.toContain("`ib customer foo`");
    expect(String(env.hint)).toContain("run `ib customer --help`");
  });

  test("a nested related command is reached through its subgroup", async () => {
    const env = await run(["palaute", "list"], hit("palaute", "ib dev feedback create"));
    expect(String(env.hint)).toContain("`ib dev feedback list` does");
  });

  test("not consulted when an offline layer already answered, or for a non-word token", async () => {
    const lookup = vi.fn(hit("x", "ib customer"));
    await run(["grid"], lookup); // ROOT_FEATURE_DOMAINS answers
    await run(["x1"], lookup); // not word-shaped
    expect(lookup).not.toHaveBeenCalled();
  });
});
