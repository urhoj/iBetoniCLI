import { describe, test, expect } from "vitest";
import { formatHelp } from "../../src/output/help.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

describe("formatHelp AI NOTES section", () => {
  test("renders AI NOTES + feedback hint when the spec has a detail", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib keikka latest")!;
    expect(spec.detail, "exemplar detail present").toBeTruthy();
    const help = formatHelp(spec);
    expect(help).toContain("AI NOTES (business context)");
    expect(help).toContain("Keikka = yksi betonin");
    expect(help).toContain('--command "reference detail keikka latest"');
  });

  test("omits AI NOTES when the spec has no detail", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib keikka get")!;
    expect(spec.detail).toBeUndefined();
    expect(formatHelp(spec)).not.toContain("AI NOTES");
  });
});
