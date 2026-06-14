import { describe, test, expect, vi } from "vitest";
import { runEmbedded, type EmbeddedCtx } from "../../src/embedded.js";
import { writeJson, writeError, exitWithError, setOutputMode } from "../../src/output/json.js";
import { CliError } from "../../src/api/errors.js";
import { runReferenceDump } from "../../src/reference/dump.js";

function ctx(): EmbeddedCtx {
  return { token: "t", endpoint: "x", readOnly: false, outputMode: "json", activeCommandErrors: null, stdout: [], stderr: [], exitCode: null };
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
  test("outside embedded mode still writes to process.stdout (unchanged)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeJson({ a: 1 });
    expect(spy).toHaveBeenCalledWith('{"a":1}\n');
    spy.mockRestore();
  });
});
