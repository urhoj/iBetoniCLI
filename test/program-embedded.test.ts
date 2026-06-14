import { describe, test, expect, vi } from "vitest";
import { buildProgram, enableParserThrow, handleParseRejection } from "../src/program.js";
import { runEmbedded, type EmbeddedCtx } from "../src/embedded.js";

function ctx(): EmbeddedCtx {
  return { token: "t", endpoint: "http://127.0.0.1:9/x", readOnly: false, outputMode: "json", activeCommandErrors: null, stdout: [], stderr: [], exitCode: null };
}

describe("embedded parser-error routing", () => {
  test("an unknown command routes its usage error to ctx, not process", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const c = ctx();
    await runEmbedded(c, async () => {
      const program = buildProgram();
      const parserText = enableParserThrow(program);
      await program.parseAsync(["node", "ib", "definitely-not-a-command"]).catch((e) => handleParseRejection(e, parserText));
    });
    expect(c.exitCode).not.toBe(null);
    expect(c.stderr.join("").length).toBeGreaterThan(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
