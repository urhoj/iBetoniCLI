import { describe, test, expect } from "vitest";
import {
  addGlobalOptions,
  GlobalOptions,
  getGlobalOptions,
} from "../src/globals";
import { CliError } from "../src/api/errors";
import { Command } from "commander";

describe("global options", () => {
  test("addGlobalOptions registers --endpoint, --request-id, --quiet, --verbose, --pretty, --json, --read-only", () => {
    const cmd = new Command();
    addGlobalOptions(cmd);
    const opts = cmd.options.map((o) => o.long);
    expect(opts).toEqual(
      expect.arrayContaining([
        "--endpoint",
        "--request-id",
        "--quiet",
        "--verbose",
        "--pretty",
        "--json",
        "--read-only",
      ])
    );
  });

  test("--read-only flag sets readOnly true", () => {
    const cmd = new Command();
    addGlobalOptions(cmd);
    cmd.parse(["node", "test", "--read-only"]);
    expect(getGlobalOptions(cmd).readOnly).toBe(true);
  });

  test("IB_READ_ONLY=1 sets readOnly true without the flag", () => {
    const prev = process.env.IB_READ_ONLY;
    process.env.IB_READ_ONLY = "1";
    try {
      const cmd = new Command();
      addGlobalOptions(cmd);
      cmd.parse(["node", "test"]);
      expect(getGlobalOptions(cmd).readOnly).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.IB_READ_ONLY;
      else process.env.IB_READ_ONLY = prev;
    }
  });

  test("readOnly defaults to false (no flag, no env)", () => {
    const prev = process.env.IB_READ_ONLY;
    delete process.env.IB_READ_ONLY;
    try {
      const cmd = new Command();
      addGlobalOptions(cmd);
      cmd.parse(["node", "test"]);
      expect(getGlobalOptions(cmd).readOnly).toBe(false);
    } finally {
      if (prev !== undefined) process.env.IB_READ_ONLY = prev;
    }
  });

  // The global company-context flag is `--company`, NOT `--asiakas`: a root
  // `--asiakas` would shadow the 14 subcommands with their own local
  // `--asiakas <id>` flag (Commander recognises root options anywhere).
  test("--company <id> parses to GlobalOptions.asiakas as a number", () => {
    const cmd = new Command();
    addGlobalOptions(cmd);
    cmd.parse(["node", "test", "--company", "26"]);
    expect(getGlobalOptions(cmd).asiakas).toBe(26);
  });

  test("asiakas defaults to null when --company is absent", () => {
    const cmd = new Command();
    addGlobalOptions(cmd);
    cmd.parse(["node", "test"]);
    expect(getGlobalOptions(cmd).asiakas).toBeNull();
  });

  test("--asiakas is NOT a global option (reserved for subcommand-local flags)", () => {
    const cmd = new Command();
    addGlobalOptions(cmd);
    expect(cmd.options.map((o) => o.long)).not.toContain("--asiakas");
  });

  // Invalid --company THROWS a CliError(exit 4) instead of process.exit():
  // forced exit is Windows-unsafe post-fetch; the action/bin catch emits the
  // envelope with the mapped code.
  test.each([["abc"], ["0"], ["-3"], ["1.5"]])(
    "--company %s (not a positive integer) throws CliError exit 4",
    (bad) => {
      const cmd = new Command();
      addGlobalOptions(cmd);
      cmd.parse(["node", "test", "--company", bad]);
      let err: unknown;
      try {
        getGlobalOptions(cmd);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(4);
      expect((err as CliError).message).toMatch(/--company/);
    }
  );

  test("getGlobalOptions reads flags from a parsed Command", () => {
    const cmd = new Command();
    addGlobalOptions(cmd);
    cmd.parse([
      "node",
      "test",
      "--endpoint",
      "https://x.test",
      "--pretty",
      "--quiet",
    ]);
    const g: GlobalOptions = getGlobalOptions(cmd);
    expect(g.endpoint).toBe("https://x.test");
    expect(g.pretty).toBe(true);
    expect(g.quiet).toBe(true);
    expect(g.verbose).toBe(false);
  });
});
