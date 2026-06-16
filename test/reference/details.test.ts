import { describe, test, expect } from "vitest";
import { COMMAND_DETAILS, MAX_DETAIL_LEN } from "../../src/reference/details.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

describe("COMMAND_DETAILS (on-demand business context)", () => {
  const commandPaths = new Set(COMMAND_SPECS.map((s) => s.command));

  test("every detail key matches a real command (no orphans)", () => {
    const orphans = Object.keys(COMMAND_DETAILS).filter((k) => !commandPaths.has(k));
    expect(orphans, `orphan detail keys: ${orphans.join(", ")}`).toEqual([]);
  });

  test("every detail is non-empty and within the soft length bound", () => {
    for (const [cmd, detail] of Object.entries(COMMAND_DETAILS)) {
      expect(detail.trim().length, `${cmd} detail empty`).toBeGreaterThan(0);
      expect(detail.length, `${cmd} detail too long (${detail.length})`).toBeLessThanOrEqual(
        MAX_DETAIL_LEN
      );
    }
  });

  test("merge attaches detail onto COMMAND_SPECS", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib keikka latest");
    expect(spec?.detail).toBe(COMMAND_DETAILS["ib keikka latest"]);
  });

  test("merge preserves description and leaves no-detail commands undefined", () => {
    const detailed = COMMAND_SPECS.find((s) => s.command === "ib keikka latest");
    expect(detailed?.description).toMatch(/recent keikka|filters/i);
    const noDetail = COMMAND_SPECS.find((s) => s.command === "ib keikka get");
    expect(noDetail?.detail).toBeUndefined();
  });
});
