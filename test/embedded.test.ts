import { describe, test, expect } from "vitest";
import { getEmbeddedCtx, runEmbedded, type EmbeddedCtx } from "../src/embedded.js";

function freshCtx(): EmbeddedCtx {
  return { token: "t", endpoint: "http://x", readOnly: false, outputMode: "json", activeCommandErrors: null, stdout: [], stderr: [], exitCode: null };
}

describe("embedded context", () => {
  test("getEmbeddedCtx is undefined outside runEmbedded", () => {
    expect(getEmbeddedCtx()).toBeUndefined();
  });
  test("runEmbedded scopes the ctx and isolates concurrent runs", async () => {
    const a = freshCtx(); a.token = "A";
    const b = freshCtx(); b.token = "B";
    const seen: string[] = [];
    await Promise.all([
      runEmbedded(a, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(getEmbeddedCtx()!.token); }),
      runEmbedded(b, async () => { seen.push(getEmbeddedCtx()!.token); }),
    ]);
    expect(seen.sort()).toEqual(["A", "B"]);
    expect(getEmbeddedCtx()).toBeUndefined();
  });
});
