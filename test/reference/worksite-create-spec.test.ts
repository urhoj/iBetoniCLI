import { describe, it, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs";

describe("ib worksite create spec truthfulness", () => {
  const spec = COMMAND_SPECS.find((s) => s.command === "ib worksite create");

  it("exists", () => {
    expect(spec).toBeDefined();
  });

  it("does not document fields the route never reads", () => {
    const examples = (spec!.examples ?? []).join(" ");
    // `name` and `address` are not real POST /api/tyomaa/new column names —
    // the fb#1562 bug used them where `tyomaaNimi`/`tyomaaOsoite1` belong.
    expect(examples).not.toContain('"name"');
    expect(examples).not.toContain('"address"');
  });

  it("its first example carries the required field", () => {
    const first = (spec!.examples ?? [])[0] ?? "";
    expect(first).toContain("ownerAsiakasId");
  });

  it("names the required field in the description", () => {
    expect(spec!.description).toContain("ownerAsiakasId");
  });
});
