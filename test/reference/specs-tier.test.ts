import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

const byCmd = (c: string) => COMMAND_SPECS.find((s) => s.command === c)!;

describe("tier tagging", () => {
  const MUST_BE_DEVELOPER = [
    "ib ai conversation",
    "ib schema tables",
    "ib schema table",
    "ib schema views",
    "ib schema view",
    "ib schema procs",
    "ib schema proc",
    "ib schema dump",
    "ib feedback list",
    "ib feedback get",
    "ib feedback resolve",
    "ib cache stats",
    "ib cache keys",
    "ib cache clear",
    "ib cache pattern",
    "ib bug admin update",
    "ib bug admin assign",
    "ib bug admin stats",
    "ib bug admin delete",
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
  ];
  // Per-tenant company-admin OR open — MUST stay visible (untagged).
  const MUST_NOT_BE_DEVELOPER = [
    "ib feedback create",
    "ib cache invalidate",
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
