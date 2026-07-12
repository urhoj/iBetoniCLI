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

describe("formatHelp ARGUMENTS", () => {
  test("renders positionals in USAGE and an ARGUMENTS section", () => {
    const out = formatHelp({
      ...base,
      command: "ib keikka get",
      args: [{ name: "keikkaId", type: "number", description: "the keikkaId to fetch" }],
    });
    expect(out).toContain("ib keikka get <keikkaId> [flags]");
    expect(out).toContain("ARGUMENTS");
    expect(out).toContain("<keikkaId> NUMBER");
    expect(out).toContain("(required)");
  });

  test("optional positional is bracketed in USAGE", () => {
    const out = formatHelp({
      ...base,
      command: "ib person companies",
      args: [{ name: "personId", type: "number", required: false, description: "defaults to caller" }],
    });
    expect(out).toContain("ib person companies [<personId>] [flags]");
    expect(out).toContain("(optional)");
  });

  test("flag marked required gets a (required) suffix", () => {
    const out = formatHelp({
      ...base,
      flags: [{ name: "asiakas", type: "number", required: true, description: "target" }],
    });
    expect(out).toMatch(/--asiakas NUMBER.*\(required\)/);
  });

  test("boolean flags render as bare switches with no type placeholder (fb#176)", () => {
    const out = formatHelp({
      ...base,
      flags: [
        { name: "full", type: "boolean", description: "return the full row" },
        { name: "limit", type: "number", description: "cap" },
      ],
    });
    // no "BOOLEAN" placeholder anywhere, and --full is a bare switch
    expect(out).not.toContain("BOOLEAN");
    expect(out).toMatch(/--full {4}return the full row/);
    // non-boolean flags keep their type placeholder
    expect(out).toContain("--limit NUMBER");
  });
});

describe("formatHelp AUTH + timezone", () => {
  test("auth:any prints an explicit login line", () => {
    const out = formatHelp({ ...base, auth: "any" });
    expect(out).toContain("Auth: requires login (any authenticated user).");
  });
  test("auth:none prints a public line", () => {
    const out = formatHelp({ ...base, auth: "none" });
    expect(out).toContain("Auth: none (public).");
  });
  test("permissions take precedence over auth", () => {
    const out = formatHelp({ ...base, permissions: ["auth.page.x.read"] });
    expect(out).toContain("Permissions: requires auth.page.x.read.");
    expect(out).not.toContain("Auth:");
  });
  test("timezone line only when a date arg/flag exists", () => {
    expect(formatHelp(base)).not.toContain("Timezone:");
    expect(formatHelp({ ...base, flags: [{ name: "from", type: "date", description: "d" }] }))
      .toContain("Timezone:");
    expect(formatHelp({ ...base, args: [{ name: "d", type: "date", description: "day" }] }))
      .toContain("Timezone:");
  });
});

describe("formatHelp NOTES + SEE ALSO", () => {
  test("renders notes bullets and see-also list", () => {
    const out = formatHelp({
      ...base,
      notes: ["Side effect: builds a keikka.", "Provider only."],
      seeAlso: ["ib jerry offer accept", "ib jerry request get"],
    });
    expect(out).toContain("NOTES");
    expect(out).toContain("  - Side effect: builds a keikka.");
    expect(out).toContain("SEE ALSO");
    expect(out).toContain("ib jerry offer accept, ib jerry request get");
    expect(out.indexOf("NOTES")).toBeLessThan(out.indexOf("EXAMPLES"));
    expect(out.indexOf("SEE ALSO")).toBeLessThan(out.indexOf("EXAMPLES"));
  });
  test("omits NOTES/SEE ALSO sections when absent", () => {
    const out = formatHelp({ ...base });
    expect(out).not.toContain("NOTES");
    expect(out).not.toContain("SEE ALSO");
  });
});
