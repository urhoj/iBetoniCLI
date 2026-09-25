import { describe, it, expect } from "vitest";
import { projectPersonName } from "../../src/commands/_shared/personRow.js";

describe("projectPersonName (fb#692)", () => {
  it("joins first + last and passes email", () => {
    expect(projectPersonName({ personFirstName: "Matti", personLastName: "M", personEmail: "m@x.fi" }))
      .toEqual({ name: "Matti M", email: "m@x.fi" });
  });
  it("tolerates missing/null parts: trimmed name, null email", () => {
    expect(projectPersonName({ personFirstName: null, personLastName: "M" })).toEqual({ name: "M", email: null });
    expect(projectPersonName({ personEmail: "" })).toEqual({ name: "", email: null });
  });
});
