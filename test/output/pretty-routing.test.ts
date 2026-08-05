import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { setOutputMode, writeJson, writeErrorEnvelope } from "../../src/output/json.js";
import { renderError } from "../../src/output/pretty.js";

describe("writeJson mode routing", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    setOutputMode("json"); // reset between tests
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    setOutputMode("json");
  });

  test("default mode emits JSON with newline", () => {
    writeJson({ a: 1 });
    expect(stdoutSpy).toHaveBeenCalledWith('{"a":1}\n');
  });

  test('pretty mode renders ListEnvelope as a table', () => {
    setOutputMode("pretty");
    writeJson({ items: [{ id: 1, name: "A" }], nextCursor: null, count: 1 });
    const out = String(stdoutSpy.mock.calls[0][0]);
    expect(out).toContain("id");
    expect(out).toContain("name");
    expect(out).toContain("A");
    expect(out.trimEnd().endsWith("}")).toBe(false);
  });

  test('pretty mode renders single record as key-value table', () => {
    setOutputMode("pretty");
    writeJson({ keikkaId: 9001, pvm: "2026-06-01" });
    const out = String(stdoutSpy.mock.calls[0][0]);
    expect(out).toMatch(/keikkaId.*9001/);
    expect(out).toMatch(/pvm.*2026-06-01/);
  });

  test('pretty mode falls through to JSON for primitives', () => {
    setOutputMode("pretty");
    writeJson(42);
    expect(stdoutSpy).toHaveBeenCalledWith("42\n");
  });
});

/**
 * `--pretty` must reach the ERROR path too — it used to stop at writeJson, so
 * every failure printed the compact envelope regardless of the flag.
 */
describe("writeErrorEnvelope mode routing", () => {
  const ENV = {
    success: false,
    error: 'unknown command "8" under `ib company`',
    code: "USAGE",
    statusCode: 0,
    group: "ib company",
    didYouMean: null,
    available: ["list", "current", "switch"],
    hint: "Run `ib company --help`.",
  };
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setOutputMode("json");
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setOutputMode("json");
  });

  test("json mode is byte-identical to a bare JSON.stringify (machine contract)", () => {
    writeErrorEnvelope(ENV, 4);
    expect(stderrSpy).toHaveBeenCalledWith(JSON.stringify(ENV) + "\n");
  });

  test("pretty mode renders the human block", () => {
    setOutputMode("pretty");
    writeErrorEnvelope(ENV, 4);
    const out = String(stderrSpy.mock.calls[0][0]);
    expect(out).toContain('✗ unknown command "8" under `ib company`');
    expect(out).toContain("[USAGE]");
    expect(out).toContain("(exit 4)");
    expect(out.startsWith("{")).toBe(false);
  });
});

describe("renderError", () => {
  const ENV = {
    success: false,
    error: "boom",
    code: "USAGE",
    statusCode: 0,
    group: "ib company",
    didYouMean: null,
    available: ["list", "current", "switch"],
  };

  test("drops the headline keys, nulls and the placeholder statusCode 0", () => {
    const out = renderError(ENV);
    expect(out).toContain("✗ boom");
    expect(out).not.toContain("success");
    expect(out).not.toContain("didYouMean");
    expect(out).not.toContain("statusCode");
    expect(out).toContain("group:");
  });

  test("keeps a real statusCode and an empty list stays hidden", () => {
    const out = renderError({ error: "nope", statusCode: 404, available: [] });
    expect(out).toContain("statusCode:");
    expect(out).toContain("404");
    expect(out).not.toContain("available");
  });

  test("scalar lists read as prose", () => {
    expect(renderError(ENV)).toContain("list, current, switch");
  });

  test("problems[] keeps the table renderer's one-line-per-problem shape", () => {
    const out = renderError({
      error: "missing required flags",
      code: "VALIDATION",
      problems: [
        { flag: "--type", issue: "missing", allowed: null },
        { flag: "--area", issue: "missing" },
      ],
    });
    expect(out).toContain("flag: --type  issue: missing");
    expect(out).toContain("flag: --area  issue: missing");
    // null fields are dropped by formatCell, not printed as "null"
    expect(out).not.toContain("allowed");
  });

  test("omits the exit line when no code is supplied", () => {
    expect(renderError({ error: "x" })).not.toContain("(exit");
  });
});
