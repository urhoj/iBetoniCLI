import { describe, test, expect } from "vitest";
import {
  COMMAND_SUMMARIES,
  MAX_SUMMARY_LEN,
} from "../../src/reference/summaries.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { buildReference } from "../../src/reference/dump.js";

describe("COMMAND_SUMMARIES (AI-catalog blurbs)", () => {
  const commandPaths = new Set(COMMAND_SPECS.map((s) => s.command));

  test("every summary key matches a real command (no orphans)", () => {
    const orphans = Object.keys(COMMAND_SUMMARIES).filter(
      (k) => !commandPaths.has(k)
    );
    expect(orphans, `orphan summary keys: ${orphans.join(", ")}`).toEqual([]);
  });

  test("every summary is non-empty and within the length cap", () => {
    for (const [cmd, summary] of Object.entries(COMMAND_SUMMARIES)) {
      expect(summary.trim().length, `${cmd} summary empty`).toBeGreaterThan(0);
      expect(summary.length, `${cmd} summary too long (${summary.length})`).toBeLessThanOrEqual(
        MAX_SUMMARY_LEN
      );
      // single-line — the catalog joins on \n, so a newline would shift rows
      expect(summary.includes("\n"), `${cmd} summary has a newline`).toBe(false);
    }
  });

  test("summaries are shorter than the description first line they replace", () => {
    // The whole point: the curated blurb must actually save tokens.
    for (const spec of COMMAND_SPECS) {
      const summary = COMMAND_SUMMARIES[spec.command];
      if (!summary) continue;
      const firstLine = String(spec.description).split("\n")[0];
      expect(
        summary.length,
        `${spec.command}: summary (${summary.length}) not shorter than firstLine (${firstLine.length})`
      ).toBeLessThan(firstLine.length);
    }
  });

  test("merge attaches summary onto COMMAND_SPECS without touching description", () => {
    const keikkaList = COMMAND_SPECS.find((s) => s.command === "ib keikka list");
    expect(keikkaList?.summary).toBe(COMMAND_SUMMARIES["ib keikka list"]);
    // full description is preserved for --help / dump
    expect(keikkaList?.description).toMatch(/date range/);
    // a command with no curated summary stays undefined (falls back downstream)
    const get = COMMAND_SPECS.find((s) => s.command === "ib keikka get");
    expect(get?.summary).toBe(COMMAND_SUMMARIES["ib keikka get"]); // short one IS curated
    const schedule = COMMAND_SPECS.find((s) => s.command === "ib company switch");
    expect(schedule?.summary).toBeUndefined();
  });

  test("buildReference emits summary in the dump (so puminet5api can read it)", () => {
    const ref = buildReference();
    const spec = ref.commands["ib keikka list"];
    expect(spec.summary).toBe(COMMAND_SUMMARIES["ib keikka list"]);
    expect(spec.description.length).toBeGreaterThan(spec.summary!.length);
  });

  test("covers the long descriptions: most >80-char first lines have a summary", () => {
    const longUncovered = COMMAND_SPECS.filter(
      (s) =>
        String(s.description).split("\n")[0].length > 80 &&
        !COMMAND_SUMMARIES[s.command]
    ).map((s) => s.command);
    expect(longUncovered, `long firstlines without a summary: ${longUncovered.join(", ")}`).toEqual(
      []
    );
  });
});
