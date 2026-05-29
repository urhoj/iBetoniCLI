import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { setOutputMode, writeJson } from "../../src/output/json.js";

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
