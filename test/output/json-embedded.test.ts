import { describe, test, expect, vi } from "vitest";
import { runEmbedded, makeEmbeddedCtx, type EmbeddedCtx } from "../../src/embedded.js";
import { writeJson, exitWithError, setExitCode } from "../../src/output/json.js";
import { CliError } from "../../src/api/errors.js";
import { runReferenceDump } from "../../src/reference/dump.js";

// Built through the factory, never as a literal (fb#487): this helper used to
// declare `: EmbeddedCtx` while omitting listColumns/tier/commandPath (and later
// projectionColumns), which is a compile error anywhere in src/ but was invisible
// here — and an incomplete ctx does not fail loudly, it falls through to module
// state inside embedded mode.
function ctx(seed: Partial<EmbeddedCtx> = {}): EmbeddedCtx {
  return makeEmbeddedCtx({ token: "t", endpoint: "x", tier: "developer", ...seed });
}

describe("json.ts embedded routing", () => {
  test("writeJson writes to ctx.stdout, not process.stdout, in embedded mode", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const c = ctx();
    await runEmbedded(c, async () => writeJson({ ok: true }));
    expect(c.stdout.join("")).toBe('{"ok":true}\n');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  test("exitWithError sets ctx.exitCode + ctx.stderr, not process", async () => {
    const outSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const c = ctx();
    await runEmbedded(c, async () => exitWithError(new CliError("nope", 403, null, 3)));
    expect(c.exitCode).toBe(3);
    expect(c.stderr.join("")).toContain('"error":"nope"');
    expect(outSpy).not.toHaveBeenCalled();
    outSpy.mockRestore();
  });
  test("reference dump output is captured by ctx in embedded mode", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const c = ctx();
    await runEmbedded(c, async () => { runReferenceDump(); });
    expect(spy).not.toHaveBeenCalled();
    expect(c.stdout.join("")).toMatch(/^\{.*\}\n$/);
    expect(() => JSON.parse(c.stdout.join("").trim())).not.toThrow();
    spy.mockRestore();
  });
  test("setExitCode sets ctx.exitCode in embedded mode, process.exitCode otherwise", async () => {
    const c = ctx();
    await runEmbedded(c, async () => setExitCode(7));
    expect(c.exitCode).toBe(7);
    // outside embedded: writes process.exitCode (save/restore to avoid polluting the runner)
    const prev = process.exitCode;
    setExitCode(0);
    expect(process.exitCode).toBe(0);
    process.exitCode = prev;
  });
  test("outside embedded mode still writes to process.stdout (unchanged)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeJson({ a: 1 });
    expect(spy).toHaveBeenCalledWith('{"a":1}\n');
    spy.mockRestore();
  });
  // fb#451: --columns projection rides the ctx, never module state — a
  // concurrent non-embedded write stays unprojected.
  test("--columns projection is ctx-scoped in embedded mode", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const c = ctx({ projectionColumns: ["a"] });
    await runEmbedded(c, async () => writeJson({ a: 1, b: 2 }));
    expect(c.stdout.join("")).toBe('{"a":1}\n');
    writeJson({ a: 1, b: 2 });
    expect(spy).toHaveBeenCalledWith('{"a":1,"b":2}\n');
    spy.mockRestore();
  });
});
