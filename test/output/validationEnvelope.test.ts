import { describe, test, expect } from "vitest";
import {
  buildValidationEnvelope,
  USAGE_HINT,
  type FlagProblem,
} from "../../src/output/validationEnvelope.js";
import type { CommandSpec } from "../../src/output/help.js";

const spec: CommandSpec = {
  command: "ib demo run",
  description: "demo",
  flags: [
    { name: "mode", type: "string", allowed: ["fast", "slow"], synonyms: { quick: "fast" }, description: "mode" },
    { name: "title", type: "string", description: "title" },
  ],
  outputShape: "{}",
  errors: [],
  examples: ["ib demo run --mode fast --title x"],
};

describe("buildValidationEnvelope", () => {
  test("fills allowed + synonyms from the injected spec when the problem omits them", () => {
    const problems: FlagProblem[] = [{ flag: "--mode", issue: "invalid", got: "warp" }];
    const env = buildValidationEnvelope("ib demo run", problems, { spec });
    expect(env.problems[0].allowed).toEqual(["fast", "slow"]);
    expect(env.problems[0].synonyms).toEqual({ quick: "fast" });
  });

  test("derives the sample from the spec's first example", () => {
    const env = buildValidationEnvelope("ib demo run", [{ flag: "--mode", issue: "missing" }], { spec });
    expect(env.sample).toBe("ib demo run --mode fast --title x");
  });

  test("opts.sample overrides the spec example", () => {
    const env = buildValidationEnvelope("ib demo run", [{ flag: "--mode", issue: "missing" }], {
      spec,
      sample: "custom sample",
    });
    expect(env.sample).toBe("custom sample");
  });

  test("caller-supplied allowed wins over the spec", () => {
    const env = buildValidationEnvelope(
      "ib demo run",
      [{ flag: "--mode", issue: "invalid", got: "x", allowed: ["a", "b"] }],
      { spec }
    );
    expect(env.problems[0].allowed).toEqual(["a", "b"]);
  });

  test("no spec → problems pass through unchanged, no sample", () => {
    const env = buildValidationEnvelope("ib demo run", [{ flag: "--title", issue: "missing" }]);
    expect(env.problems[0]).toEqual({ flag: "--title", issue: "missing" });
    expect(env.sample).toBeUndefined();
    expect(env.code).toBe("USAGE");
    expect(env.statusCode).toBe(0);
    expect(env.hint).toBe(USAGE_HINT);
  });

  test("summary lists missing flags", () => {
    const env = buildValidationEnvelope("ib demo run", [
      { flag: "--mode", issue: "missing" },
      { flag: "--title", issue: "missing" },
    ]);
    expect(env.error).toBe("missing required flags: --mode, --title for ib demo run");
  });

  test("summary lists invalid values with the rejected input", () => {
    const env = buildValidationEnvelope("ib demo run", [{ flag: "--mode", issue: "invalid", got: "warp" }]);
    expect(env.error).toBe("invalid value: --mode=warp for ib demo run");
  });

  test("summary combines missing + invalid", () => {
    const env = buildValidationEnvelope("ib demo run", [
      { flag: "--mode", issue: "invalid", got: "warp" },
      { flag: "--title", issue: "missing" },
    ]);
    expect(env.error).toContain("missing required flag: --title");
    expect(env.error).toContain("invalid value: --mode=warp");
  });
});
