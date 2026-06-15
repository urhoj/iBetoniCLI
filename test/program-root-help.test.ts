import { describe, test, expect, afterEach } from "vitest";
import { buildProgram } from "../src/program.js";
import { setCallerTier } from "../src/tier.js";

afterEach(() => setCallerTier("developer"));

function rootHelp(tier: "developer" | "standard"): string {
  setCallerTier(tier);
  return buildProgram().helpInformation();
}

describe("root --help command listing is tier-filtered", () => {
  test("standard omits ai/schema/changelog from the Commands list", () => {
    const h = rootHelp("standard");
    // The Commands: section should not list these as top-level groups.
    expect(h).not.toMatch(/^\s+schema\b/m);
    expect(h).not.toMatch(/^\s+changelog\b/m);
    expect(h).not.toMatch(/^\s+ai\b/m);
    expect(h).toMatch(/^\s+keikka\b/m); // visible domain still listed
  });
  test("developer lists schema/ai/changelog", () => {
    const h = rootHelp("developer");
    expect(h).toMatch(/^\s+schema\b/m);
    expect(h).toMatch(/^\s+ai\b/m);
    expect(h).toMatch(/^\s+changelog\b/m);
  });
});
