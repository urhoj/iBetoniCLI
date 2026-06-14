import { describe, test, expect } from "vitest";
import { runArgv } from "../src/runArgv.js";

describe("runArgv", () => {
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
