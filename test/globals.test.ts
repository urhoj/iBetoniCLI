import { describe, test, expect } from "vitest";
import {
  addGlobalOptions,
  GlobalOptions,
  getGlobalOptions,
} from "../src/globals";
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
