import { describe, test, expect } from "vitest";
import {
  addGlobalOptions,
  GlobalOptions,
  getGlobalOptions,
} from "../src/globals";
import { Command } from "commander";

describe("global options", () => {
  test("addGlobalOptions registers --endpoint, --request-id, --quiet, --verbose, --pretty, --json", () => {
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
      ])
    );
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
