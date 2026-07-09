import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

const byCmd = (c: string) => COMMAND_SPECS.find((s) => s.command === c)!;

describe("tier tagging", () => {
  const MUST_BE_DEVELOPER = [
    "ib dev ai conversation",
    "ib dev schema tables",
    "ib dev schema table",
    "ib dev schema views",
    "ib dev schema view",
    "ib dev schema procs",
    "ib dev schema proc",
    "ib dev schema dump",
    "ib dev feedback list",
    "ib dev feedback get",
    "ib dev feedback resolve",
    "ib dev cache stats",
    "ib dev cache keys",
    "ib dev cache clear",
    "ib dev cache pattern",
    "ib jerry admin list",
    "ib jerry admin search",
    "ib jerry admin detail",
    "ib jerry admin enable",
    "ib jerry admin disable",
    "ib message support inbox",
    "ib message support resolve",
    "ib legal save",
    "ib legal activate",
    "ib legal delete",
    "ib legal acceptances",
    "ib legal accept",
    "ib legal type create",
    "ib legal type update",
    "ib dev changelog add",
    "ib dev changelog list",
    "ib dev changelog get",
    "ib dev changelog update",
    "ib dev changelog report",
  ];
  // Per-tenant company-admin OR open — MUST stay visible (untagged).
  const MUST_NOT_BE_DEVELOPER = [
    "ib dev feedback create",
    "ib dev cache invalidate",
    "ib customer modules",
    "ib customer operator",
    "ib customer settings",
    "ib jerry provider-settings get",
    "ib jerry provider-settings set",
    "ib person owner",
    "ib message support contact",
    "ib ohje update",
    "ib log latest",
    "ib log range",
    "ib log by-entity-date",
  ];

  test.each(MUST_BE_DEVELOPER)("%s is tier:developer", (cmd) => {
    expect(byCmd(cmd).tier).toBe("developer");
  });
  test.each(MUST_NOT_BE_DEVELOPER)("%s is NOT tier:developer", (cmd) => {
    expect(byCmd(cmd).tier).toBeUndefined();
  });

  test("no tagged leaf advertises cross-tenant PII reads", () => {
    for (const s of COMMAND_SPECS) {
      if (s.tier === "developer") {
        expect(s.description.toLowerCase()).not.toContain("may contain customer pii");
        expect(s.description.toLowerCase()).not.toContain("any tenant");
      }
    }
  });
});
