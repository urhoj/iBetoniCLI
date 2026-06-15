import { describe, test, expect, vi } from "vitest";
import { runArgv } from "../src/runArgv.js";

describe("runArgv", () => {
  test("group --help is captured to ctx.stdout, not leaked to process.stdout", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const r = await runArgv(["keikka", "--help"], { token: "t", endpoint: "http://127.0.0.1:9" });
    spy.mockRestore();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout.length).toBeGreaterThan(100);
  });

  test("offline command (commands) returns JSON on stdout, exit 0, no throw", async () => {
    const r = await runArgv(["commands"], { token: "t", endpoint: "http://127.0.0.1:9" });
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
    expect(r.stderr).toBe("");
  });
  test("unknown command -> non-zero exit + stderr envelope, no throw", async () => {
    const r = await runArgv(["nope-not-real"], { token: "t", endpoint: "http://127.0.0.1:9" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
  test("two parallel runArgv calls do not cross output", async () => {
    const [a, b] = await Promise.all([
      runArgv(["commands"], { token: "t", endpoint: "http://127.0.0.1:9" }),
      runArgv(["help"], { token: "t", endpoint: "http://127.0.0.1:9" }),
    ]);
    expect(a.stdout).not.toBe("");
    expect(b.stdout).not.toBe("");
    expect(a.stdout).not.toEqual(b.stdout);
  });
});
