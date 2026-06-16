import { describe, test, expect } from "vitest";
import { buildReference } from "../../src/reference/dump.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

describe("ib reference dump strips detail", () => {
  test("a detailed command keeps its detail on the spec but NOT in the dump", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib keikka latest")!;
    expect(spec.detail, "spec carries detail").toBeTruthy();
    const ref = buildReference();
    expect(ref.commands["ib keikka latest"]).toBeDefined();
    expect(ref.commands["ib keikka latest"].detail).toBeUndefined();
    // summary is still emitted (the catalog needs it)
    expect(ref.commands["ib keikka latest"].summary).toBe(spec.summary);
  });
});
