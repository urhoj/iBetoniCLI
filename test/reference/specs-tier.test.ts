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
    "ib dev schema triggers",
    "ib dev schema trigger",
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

  // fb#810: word-boundary match, NOT a plain substring. `includes("any tenant")`
  // trips on "m[any tenant]s" — the phrase "many tenants" is not a cross-tenant
  // claim, yet it forced a reword to "numerous tenants" to go quiet. Verified:
  // the trailing 's' blocks the right boundary and the leading 'm' the left, so
  // the word-boundaried form never matches "many tenants" (nor "company
  // tenant"), while every real claim shape still does. `tenants?` keeps the
  // plural claim "any tenants" in scope. A guard that cries wolf teaches authors
  // to edit prose until it goes quiet — which is how a real hit gets waved
  // through.
  const CROSS_TENANT_CLAIM = /\bany tenants?\b/;

  test("cross-tenant claim detector: benign plurals pass, claims trip (fb#810)", () => {
    expect(CROSS_TENANT_CLAIM.test("membership in many tenants")).toBe(false);
    expect(CROSS_TENANT_CLAIM.test("how many tenants use it")).toBe(false);
    expect(CROSS_TENANT_CLAIM.test("company tenant")).toBe(false);
    expect(CROSS_TENANT_CLAIM.test("read any tenant")).toBe(true);
    expect(CROSS_TENANT_CLAIM.test("rows from any tenants")).toBe(true);
    expect(CROSS_TENANT_CLAIM.test("any tenant's data")).toBe(true);
  });

  test("no tagged leaf advertises cross-tenant PII reads", () => {
    for (const s of COMMAND_SPECS) {
      if (s.tier === "developer") {
        expect(s.description.toLowerCase()).not.toContain("may contain customer pii");
        expect(s.description.toLowerCase()).not.toMatch(CROSS_TENANT_CLAIM);
      }
    }
  });
});
