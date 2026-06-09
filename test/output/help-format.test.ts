import { describe, test, expect } from "vitest";
import { formatHelp, type CommandSpec } from "../../src/output/help.js";

const base: CommandSpec = {
  command: "ib demo run",
  description: "Demo.",
  flags: [],
  outputShape: "{ ok: true }",
  errors: [],
  examples: ["ib demo run"],
};

describe("formatHelp ERRORS", () => {
  test("renders exit code, and HTTP status when present", () => {
    const out = formatHelp({
      ...base,
      errors: [
        { http: 404, exit: 5, meaning: "Not found", remedy: "verify id" },
        { exit: 4, meaning: "Missing --reason", remedy: "pass --reason" },
      ],
    });
    expect(out).toContain("exit 5 (HTTP 404)  Not found");
    expect(out).toContain("exit 4  Missing --reason");
    expect(out).not.toContain("404  Not found");
  });
});
