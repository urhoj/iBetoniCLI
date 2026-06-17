import { describe, test, expect, vi, afterEach } from "vitest";
import { buildProgram } from "../../src/program.js";

/** Capture stdout while parsing argv through the real program (offline commands only). */
async function runCapture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((s: string | Uint8Array) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write);
  try {
    await buildProgram().parseAsync(argv, { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

afterEach(() => vi.restoreAllMocks());

describe("domain positional wiring", () => {
  test("ib commands <domain> narrows to that group", async () => {
    const env = JSON.parse(await runCapture(["commands", "keikka"]));
    expect(env.count).toBeGreaterThan(0);
    expect(
      env.items.every((i: { command: string }) => i.command.startsWith("ib keikka"))
    ).toBe(true);
  });

  test("ib reference dump <domain> narrows commands, keeps primer", async () => {
    const ref = JSON.parse(await runCapture(["reference", "dump", "keikka"]));
    const cmds = Object.keys(ref.commands);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every((c) => c.startsWith("ib keikka"))).toBe(true);
    expect(ref.overview).toContain("BetoniJerry");
    // glossary is DB-fetched at runtime; in offline tests it defaults to []
    expect(Array.isArray(ref.glossary)).toBe(true);
  });
});
