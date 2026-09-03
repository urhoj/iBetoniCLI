import { describe, it, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs";

describe("ib keikka create spec truthfulness", () => {
  const spec = COMMAND_SPECS.find((s) => s.command === "ib keikka create");

  it("exists", () => {
    expect(spec).toBeDefined();
  });

  it("does not document fields the route never reads", () => {
    const examples = (spec!.examples ?? []).join(" ");
    // `asiakasId` and `pvm` are not read by POST /api/keikka/newKeikka.
    expect(examples).not.toContain('"asiakasId"');
    expect(examples).not.toContain('"pvm"');
  });

  it("its examples carry all three required fields", () => {
    const first = (spec!.examples ?? [])[0] ?? "";
    for (const field of ["personId", "originId", "ownerAsiakasId"]) {
      expect(first).toContain(field);
    }
  });

  it("names the required fields in the description", () => {
    expect(spec!.description).toContain("ownerAsiakasId");
  });
});
