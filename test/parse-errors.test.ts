import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildProgram,
  enableParserThrow,
  handleParseRejection,
} from "../src/program.js";
import { CliError } from "../src/api/errors.js";
import { setOutputMode, setActiveCommandErrors } from "../src/output/json.js";
import { runArgv } from "../src/runArgv.js";

/**
 * Usage errors are emitted as the standard JSON envelope (code USAGE, exit 4)
 * via enableParserThrow + handleParseRejection — the parser never calls
 * process.exit and never prints plain text for errors (feedback #24).
 */
describe("parser errors → JSON envelope", () => {
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

  async function run(argv: string[]): Promise<void> {
    const program = await buildProgram();
    const hooks = enableParserThrow(program);
    await program
      .parseAsync(["node", "ib", ...argv])
      .catch((err) => handleParseRejection(err, hooks));
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

  test("missing required option → prescriptive USAGE envelope, exit 4", async () => {
    await run(["customer", "person", "add", "--person", "1"]);
    const parsed = lastStderrJson();
    expect(parsed.code).toBe("USAGE");
    expect(String(parsed.error)).toMatch(/--asiakas/);
    // Even a SINGLE missing flag now gets the structured problems[] + a sample
    // (previously only ≥2 missing produced structured output) — fb#204.
    const problems = parsed.problems as Array<{ flag: string; issue: string }>;
    expect(problems.map((p) => p.flag)).toContain("--asiakas");
    expect(problems.every((p) => p.issue === "missing")).toBe(true);
    expect(typeof parsed.sample).toBe("string");
    expect(process.exitCode).toBe(4);
  });

  test("missing required options are reported together, with allowed values + sample", async () => {
    await run(["dev", "changelog", "add", "--repo", "betonicli", "--title", "x"]);
    const parsed = lastStderrJson();
    const error = String(parsed.error);
    expect(parsed.code).toBe("USAGE");
    expect(error).toContain("--type");
    expect(error).toContain("--area");
    // --description is no longer a parser-required option (fb#172: accepted
    // positionally or via --description, resolved in the action → exit 4 there).
    const problems = parsed.problems as Array<{ flag: string; allowed?: string[] }>;
    const byFlag = Object.fromEntries(problems.map((p) => [p.flag, p]));
    // Allowed values are pulled from the command spec so the caller re-runs
    // correctly without a --help round-trip (fb#204).
    expect(byFlag["--type"].allowed).toEqual(["feature", "improvement", "bugfix"]);
    expect(byFlag["--area"].allowed).toEqual([
      "frontend",
      "backend",
      "cli",
      "database",
      "cicd",
      "workspace",
    ]);
    expect(String(parsed.sample)).toContain("ib dev changelog add");
    expect(process.exitCode).toBe(4);
  });

  test("unknown subcommand under a group → JSON envelope by default", async () => {
    await run(["company", "8"]);
    const parsed = lastStderrJson();
    expect(parsed.code).toBe("USAGE");
    expect(parsed.group).toBe("ib company");
    expect(parsed.unknownCommand).toBe("8");
    expect(parsed.available).toEqual(["list", "current", "switch"]);
    expect(process.exitCode).toBe(4);
  });

  test("--pretty renders the usage envelope as a human block, same exit 4", async () => {
    setOutputMode("pretty");
    try {
      await run(["company", "8"]);
    } finally {
      setOutputMode("json");
    }
    const out = String(stderrSpy.mock.calls.at(-1)![0]);
    expect(out.startsWith("{")).toBe(false);
    expect(out).toContain('✗ unknown command "8" under `ib company`');
    expect(out).toContain("list, current, switch");
    expect(out).toContain("(exit 4)");
    expect(process.exitCode).toBe(4);
  });

  // feedback #343 — the reported invocation. `ib company` and `ib customer` are
  // both `asiakas`; the record the caller wanted was one group over, and the
  // envelope listed only company's own three subcommands.
  test("unknown subcommand available in the sibling group → runnable cross-group hint", async () => {
    await run(["company", "get", "8"]);
    const parsed = lastStderrJson();
    expect(parsed.availableElsewhere).toEqual(["ib customer get"]);
    // …carrying the caller's own args, so the hint is copy-paste runnable.
    expect(String(parsed.hint)).toContain("`ib customer get 8` does");
    expect(String(parsed.hint)).toContain("same `asiakas` entity");
    expect(parsed.available).toEqual(["list", "current", "switch"]);
    expect(process.exitCode).toBe(4);
  });

  // fb#383 — the reported invocation, one level up from #379: the verb is owned
  // by two DOMAINS, and the root envelope used to answer with 29 group names.
  test("unknown ROOT command owned by domain groups → runnable redirect", async () => {
    await run(["dashboard"]);
    const parsed = lastStderrJson();
    expect(parsed.group).toBe("ib");
    expect(parsed.availableElsewhere).toEqual([
      "ib worksite dashboard",
      "ib sijainti dashboard",
    ]);
    expect(String(parsed.hint)).toContain("`ib worksite dashboard`, `ib sijainti dashboard`");
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
    const text = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(text).toMatch(/SUBCOMMANDS|Usage/i);
    expect(text).not.toMatch(/"code":"USAGE"/);
  });

  test("a CliError thrown outside an action try lands as envelope + mapped code", () => {
    handleParseRejection(new CliError("guard", 0, null, 3));
    const parsed = lastStderrJson();
    expect(parsed.error).toBe("guard");
    expect(process.exitCode).toBe(3);
  });

  test("non-Commander, non-CliError stays plain text exit 1", () => {
    handleParseRejection(new Error("boom"));
    expect(String(stderrSpy.mock.calls.at(-1)![0])).toBe("boom\n");
    expect(process.exitCode).toBe(1);
  });
});

/**
 * A guard that runs during PARSE (an option/argument `argParser`) throws before
 * the preAction hook that resolves the command's CommandSpec, so its envelope
 * used to carry no `hint` at all while the identical in-action guard on the same
 * command got one — the ERRORS-row contract was documentation-only for the whole
 * parse-time class (feedback #385).
 */
describe("parse-time guard errors resolve the command's own ERRORS remedy", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    setActiveCommandErrors(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setActiveCommandErrors(null);
    process.exitCode = prevExitCode;
  });

  async function envelopeFor(argv: string[]): Promise<Record<string, unknown>> {
    const program = await buildProgram();
    const hooks = enableParserThrow(program);
    await program
      .parseAsync(["node", "ib", ...argv])
      .catch((err) => handleParseRejection(err, hooks));
    return JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
  }

  test("argParser guard gets the spec remedy (the fb#385 repro)", async () => {
    const parsed = await envelopeFor(["sijainti", "closest", "--worksite", "abc", "--type", "3"]);
    expect(parsed.error).toBe("--worksite must be an integer >= 1");
    expect(parsed.hint).toBe(
      "name the worksite once (--worksite OR --tyomaa) and pass integer ids"
    );
    expect(process.exitCode).toBe(4);
  });

  test("same command, same remedy, whether the guard runs at parse or in the action", async () => {
    const atParse = await envelopeFor(["sijainti", "closest", "--worksite", "abc", "--type", "3"]);
    const inAction = await envelopeFor(["sijainti", "closest", "--type", "3"]);
    expect(atParse.hint).toBe(inAction.hint);
  });

  test("a topic-specific row is NOT served to an unrelated flag-type error", async () => {
    // `ib log entity`'s only client/exit-4 row documents an unknown entityType.
    // Resolving the spec at parse time would hand "ib log types" to a bad
    // --owner via the exit-only fallback; the flag's own hint wins instead.
    const parsed = await envelopeFor(["log", "entity", "keikka", "1", "--owner", "abc"]);
    expect(parsed.error).toBe("--owner must be an integer >= 1");
    expect(String(parsed.hint)).toMatch(/ownerAsiakasId/);
    expect(String(parsed.hint)).not.toMatch(/log types/);
    expect(process.exitCode).toBe(4);
  });

  test("--owner is answered on a command with no ERRORS row at all (fb#385's own example)", async () => {
    const parsed = await envelopeFor(["log", "latest", "--owner", "abc"]);
    expect(parsed.error).toBe("--owner must be an integer >= 1");
    expect(String(parsed.hint)).toMatch(/omit it entirely to read the active company/);
  });

  test("--person on log range no longer inherits the date row", async () => {
    const parsed = await envelopeFor([
      "log", "range", "--from", "2026-06-01", "--to", "2026-06-02", "--person", "abc",
    ]);
    expect(parsed.error).toBe("--person must be an integer >= 1");
    expect(parsed.hint).toBeUndefined();
  });

  test("a command with no client exit-4 row still emits no invented hint", async () => {
    const parsed = await envelopeFor(["company", "switch", "--to", "abc"]);
    expect(parsed.error).toBe("--to must be an integer >= 1");
    expect(parsed.hint).toBeUndefined();
  });

  test("a leaf two levels down resolves its own spec, not the group's", async () => {
    const parsed = await envelopeFor(["task", "list", "--limit", "abc"]);
    expect(parsed.error).toBe("--limit must be an integer >= 1");
    expect(String(parsed.hint)).toMatch(/must be integers/);
  });

  test("--asiakas is answered by the flag's own ERRORS row (fb#892)", async () => {
    const parsed = await envelopeFor(["person", "list", "--asiakas", "abc"]);
    expect(parsed.error).toBe("--asiakas must be an integer >= 1");
    expect(String(parsed.hint)).toMatch(/pass a positive asiakasId/);
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

/**
 * fb#371 — flags whose value lands in a URL PATH segment are validated by the
 * argParser, so a typo fails at PARSE time. Asserted end-to-end (not just on the
 * helper) because the failure mode being guarded against is a bare `Number`
 * coercer silently reaching the wire as the literal "NaN". Exit 4 naming the
 * flag — rather than the exit 2 a tokenless getClient() would give — is what
 * proves the guard fired before the action ever ran.
 */
describe("path-segment flags reject NaN at parse time (fb#371)", () => {
  const opts = { token: "", endpoint: "https://example.invalid" };

  test("ib sijainti closest --worksite abc → exit 4, no request", async () => {
    const { exitCode, stderr } = await runArgv(
      ["sijainti", "closest", "--worksite", "abc", "--type", "3"],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/--worksite must be an integer/);
  });

  test("ib sijainti closest --asiakas abc → exit 4 (survives the ?? default)", async () => {
    const { exitCode, stderr } = await runArgv(
      ["sijainti", "closest", "--worksite", "555", "--type", "3", "--asiakas", "abc"],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/--asiakas must be an integer/);
  });

  test("ib opendata weather forecast --lat 6O.17 → exit 4", async () => {
    const { exitCode, stderr } = await runArgv(
      ["opendata", "weather", "forecast", "--lat", "6O.17", "--lng", "24.94", "--time", "now"],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/--lat must be a number/);
  });

  test("ib opendata weather pumping --duration abc → exit 4", async () => {
    const { exitCode, stderr } = await runArgv(
      ["opendata", "weather", "pumping", "--lat", "60.17", "--lng", "24.94", "--start", "now", "--duration", "abc"],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/--duration must be an integer/);
  });
});

/**
 * fb#615 — `--help` on a nonexistent leaf must FAIL, so it can be used for
 * capability detection. Commander resolves --help on the group before it
 * rejects the unknown operand, so this used to render the group's help and exit
 * 0 — indistinguishable from success, and against a stale/vendored binary that
 * lacks a newer leaf it reads as "the command exists".
 */
describe("unknown leaf + --help → exit 4 (fb#615)", () => {
  const opts = { token: "", endpoint: "https://example.invalid" };

  test("--help on an unknown leaf exits 4 with the unknown-command envelope", async () => {
    const { exitCode, stderr } = await runArgv(
      ["dev", "feedback", "nosuchleaf", "--help"],
      opts
    );
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr);
    expect(env.code).toBe("USAGE");
    expect(env.unknownCommand).toBe("nosuchleaf");
    expect(env.group).toBe("ib dev feedback");
    // Tier-filtered like every other discovery surface: the token is empty, so
    // the caller resolves to "standard" and the developer-only leaves (count,
    // list, get, resolve…) are correctly absent.
    expect(env.available).toEqual(["create", "import"]);
  });

  test("--help and no---help agree on the same argv", async () => {
    const withHelp = await runArgv(["dev", "feedback", "nosuchleaf", "--help"], opts);
    const without = await runArgv(["dev", "feedback", "nosuchleaf"], opts);
    expect(withHelp.exitCode).toBe(without.exitCode);
    expect(JSON.parse(withHelp.stderr).unknownCommand).toBe(
      JSON.parse(without.stderr).unknownCommand
    );
  });

  test("the envelope carries the running build's version", async () => {
    const { stderr } = await runArgv(["dev", "feedback", "nosuchleaf"], opts);
    // Distinguishes "no such command" from "my binary predates it" — the
    // vendored puminet5api copy routinely lags betonicli master.
    expect(JSON.parse(stderr).cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The guard must not fire on legitimate help. A GROUP's own help, a LEAF's
  // help, and a leaf whose POSITIONAL args look like operands all stay exit 0.
  test.each([
    [["dev", "feedback", "--help"], "group help"],
    [["dev", "feedback", "count", "--help"], "leaf help"],
    [["reference", "detail", "get", "keikka", "list", "--help"], "leaf help past positionals"],
    [["--help"], "root help"],
    [["--version"], "version"],
  ])("%s (%s) still exits 0", async (argv) => {
    const { exitCode } = await runArgv(argv as string[], opts);
    expect(exitCode).toBe(0);
  });

  test("a registered ALIAS is not reported as unknown", async () => {
    // `stats` is a hidden alias of `count` (fb#611); --help on it is real help.
    const { exitCode } = await runArgv(["dev", "feedback", "stats", "--help"], opts);
    expect(exitCode).toBe(0);
  });

  test("no help prose leaks to stdout on the rejected path (fb#628)", async () => {
    // Commander renders the group's help before it can reject the operand, so
    // this used to exit 4 with the envelope on stderr AND help on stdout — the
    // exit code saying failure while stdout said otherwise.
    const { stdout } = await runArgv(["dev", "feedback", "nosuchleaf", "--help"], opts);
    expect(stdout).toBe("");
  });

  test("--help and no---help are byte-identical, not merely same-exit (fb#628)", async () => {
    const withHelp = await runArgv(["dev", "feedback", "nosuchleaf", "--help"], opts);
    const without = await runArgv(["dev", "feedback", "nosuchleaf"], opts);
    expect(withHelp).toEqual(without);
  });

  /**
   * A group with an `isDefault` subcommand takes an UNREGISTERED token as that
   * leaf's argument, never as an unknown command — Commander's own parse gates
   * on `_defaultCommandName` and renders the parent's help there deliberately.
   * `ib glossary` is the only such group (`lookup [term]`), so `puomi` is a
   * TERM. The first shipped fb#615 guard missed this and exited 4 on it.
   */
  test("a default-subcommand group's argument is not an unknown leaf", async () => {
    const { exitCode } = await runArgv(["glossary", "puomi", "--help"], opts);
    expect(exitCode).toBe(0);
  });

  test("bare `ib glossary` still renders its help (the manual outputHelp path)", async () => {
    // This one never throws, so it would be lost by a buffer-and-flush design —
    // the reason fb#628 suppresses at the write instead.
    const { exitCode, stdout } = await runArgv(["glossary"], opts);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/glossary/i);
  });
});

/**
 * fb#892 — the person/vehicle cross-tenant `--asiakas` flags coerced with a
 * bare `Number`, so a typo flowed into qs() as the literal "NaN" (a backend
 * failure or a silent empty result). They now parse through `intFlag`;
 * asserted end-to-end (same shape as the fb#371 block) because the failure
 * mode being guarded against is exactly a bare coercer silently reaching the
 * wire. Exit 4 naming the flag — rather than whatever the action would have
 * produced — is what proves the guard fired at parse time, before getClient.
 */
describe("person/vehicle --asiakas rejects NaN at parse time (fb#892, fb#908)", () => {
  const opts = { token: "", endpoint: "https://example.invalid" };

  test.each([
    [["person", "list", "--asiakas", "abc"]],
    [["person", "get", "1", "--asiakas", "abc"]],
    [["person", "search", "matti", "--asiakas", "abc"]],
    [["person", "role", "list", "1", "--asiakas", "abc"]],
    [["person", "role", "grant", "1", "--role", "keikkaHandler", "--asiakas", "abc"]],
    [["person", "role", "revoke", "1", "--role", "keikkaHandler", "--asiakas", "abc"]],
    // fb#908: the WRITE-path sites — a NaN here used to serialize as null and
    // silently write the wrong owner (person owner releases to GLOBAL).
    [["person", "create", "--first", "A", "--last", "B", "--asiakas", "abc"]],
    [["person", "owner", "1", "--asiakas", "abc"]],
    [["vehicle", "list", "--asiakas", "abc"]],
    [["vehicle", "get", "7", "--asiakas", "abc"]],
    [["vehicle", "types", "--asiakas", "abc"]],
    [["vehicle", "search", "kuorma", "--asiakas", "abc"]],
    [["vehicle", "create", "--reg", "ABC-1", "--asiakas", "abc"]],
    [["vehicle", "update", "7", "--asiakas", "abc"]],
  ])("ib %j → exit 4, no request", async (argv) => {
    const { exitCode, stderr } = await runArgv(argv as string[], opts);
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/--asiakas must be an integer/);
  });
});

/**
 * fb#893 — attachment ids coerced with bare `Number(id)`, so a typo became a
 * backend 404/500; they now parse through `parseId` and fail client-side exit
 * 4 before any request. The guard sits INSIDE the action (positionals have no
 * argParser), so unlike the fb#892 block a token-shaped value is needed to get
 * past getClient — an empty-payload JWT builds the client, and parseId throws
 * before the first network call. (`update` is covered too: since fb#909 its
 * action runs parseId BEFORE the name-valued --group/--type types lookup.)
 */
describe("attachment id rejects non-integers client-side (fb#893)", () => {
  const opts = { token: "eyJhbGciOiJIUzI1NiJ9.e30.c2ln", endpoint: "https://example.invalid" };

  test.each([
    [["attachment", "get", "abc"]],
    [["attachment", "download", "abc"]],
    [["attachment", "attach", "abc"]],
    [["attachment", "detach", "abc", "keikka"]],
    [["attachment", "update", "abc", "--dry-run"]],
    [["attachment", "delete", "abc", "--reason", "test"]],
  ])("ib %j → exit 4, no request", async (argv) => {
    const { exitCode, stderr } = await runArgv(argv as string[], opts);
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/invalid attachmentId: "abc"/);
  });

  test("the envelope carries the invalid-id row's remedy, not a sibling exit-4 row's (fb#385)", async () => {
    // download ALSO documents a matchless client exit-4 row ("Output file
    // exists"); without the `match: "attachmentId"` on the new row, the
    // fallback would hand its --force remedy to a bad id.
    const { stderr } = await runArgv(["attachment", "download", "abc"], opts);
    const env = JSON.parse(stderr);
    expect(String(env.hint)).toMatch(/attachmentId must be a positive integer/);
    expect(String(env.hint)).not.toMatch(/--force/);
  });
});

/**
 * fb#905 — the leftover bare-Number coercions from the fb#892/fb#893 defect
 * class: vehicle write fields (--no/--type/--default-driver via intFlag,
 * --capacity/--puomi via numFlag) and the --type/--days read filters, the
 * attachment entity-flag family + --size + --liita-laskuun (zeroOneFlag),
 * sales prospect --asiakas ×3, message daily get/share/grant, fennoa
 * --months/--asiakas, jerry request/provider-settings --asiakas, sijainti
 * create --asiakas, and validate --keikka. All guards fire at parse time
 * (argParser), so tokenless is enough — exit 4 proves no request. Sites
 * already guarded downstream were left as-is (validate --asiakas/--person,
 * sijainti plants, message daily list/add).
 *
 * Follow-up (post-impl review of a681487): the same-hunk write-body flags the
 * first pass missed — jerry request create --boom/--duration/--line-length,
 * check-address --lat/--lng, sales prospect update's profile fields + --tier,
 * sijainti create --type/--lat/--lng/--max-distance — are guarded here too,
 * and the message daily specs gained client ERRORS rows (their envelopes now
 * resolve hints). jerry check-address keeps its --explain half action-level;
 * only the NaN half moved to parse time.
 */
describe("leftover bare-Number coercions reject garbage at parse time (fb#905)", () => {
  const opts = { token: "", endpoint: "https://example.invalid" };

  test.each([
    [["vehicle", "list", "--type", "abc"]],
    [["vehicle", "dates", "expiring", "--days", "abc"]],
    [["vehicle", "visits", "tyomaa", "1", "--days", "abc"]],
    [["vehicle", "create", "--no", "abc"]],
    [["vehicle", "create", "--capacity", "abc"]],
    [["vehicle", "update", "7", "--puomi", "abc"]],
    [["attachment", "attach", "1", "--keikka", "abc"]],
    [["attachment", "register", "--size", "abc"]],
    [["attachment", "update", "1", "--liita-laskuun", "abc"]],
    [["attachment", "update", "1", "--liita-laskuun", "2"]],
    [["sales", "prospect", "get", "--asiakas", "abc"]],
    [["sales", "prospect", "add", "--asiakas", "abc"]],
    [["sales", "prospect", "update", "1", "--asiakas", "abc"]],
    [["message", "daily", "get", "1", "--asiakas", "abc"]],
    [["message", "daily", "share", "1", "--to", "abc"]],
    [["message", "daily", "grant", "1", "--to", "abc"]],
    [["fennoa", "purchases", "--months", "abc"]],
    [["jerry", "request", "create", "--asiakas", "abc"]],
    [["jerry", "provider-settings", "get", "--asiakas", "abc"]],
    [["sijainti", "create", "--asiakas", "abc"]],
    [["validate", "--keikka", "abc"]],
    // Follow-up batch (post-impl review):
    [["attachment", "detach", "1", "--keikka", "abc"]],
    [["vehicle", "create", "--type", "abc"]],
    [["sales", "prospect", "list", "--tier", "abc"]],
    [["sales", "prospect", "update", "1", "--fleet-pumps", "abc"]],
    [["message", "daily", "grant", "1", "--role", "abc"]],
    [["message", "daily", "perm-set", "1", "--role", "abc"]],
    [["fennoa", "purchases", "--asiakas", "abc"]],
    [["jerry", "request", "create", "--boom", "abc"]],
    [["jerry", "check-address", "--lat", "abc"]],
    [["jerry", "provider-settings", "set", "--asiakas", "abc"]],
    [["sijainti", "create", "--lat", "abc"]],
  ])("ib %j → exit 4, no request", async (argv) => {
    const { exitCode, stderr } = await runArgv(argv as string[], opts);
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/must be (an integer|a number|0 or 1)/);
  });
});
