import { describe, test, expect, vi } from "vitest";
import { runArgv } from "../src/runArgv.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // fb#451: the embedded runner used to ignore --columns entirely.
  test("--columns projects an offline list's rows", async () => {
    const r = await runArgv(["help", "--columns", "id"], { token: "t", endpoint: "http://127.0.0.1:9" });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout.trim());
    expect(env.count).toBeGreaterThan(0);
    for (const item of env.items) expect(Object.keys(item)).toEqual(["id"]);
  });
  test("--columns with no matching column exits 4 naming the available ones", async () => {
    const r = await runArgv(["help", "--columns", "nope"], { token: "t", endpoint: "http://127.0.0.1:9" });
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Available");
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
  // fb#856: a single-dash long flag is normalized to double-dash before
  // Commander parses, so the recurrent '-columns'/'-reason' typo resolves.
  test("single-dash long flag resolves like its double-dash form", async () => {
    const r = await runArgv(["help", "-columns", "id"], { token: "t", endpoint: "http://127.0.0.1:9" });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout.trim());
    expect(env.count).toBeGreaterThan(0);
    for (const item of env.items) expect(Object.keys(item)).toEqual(["id"]);
  });
});

describe("--from-json parity with --body (fb#1189 / fb#1187)", () => {
  const OFFLINE = { token: "t", endpoint: "http://127.0.0.1:9" };
  const jsonFile = (obj: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-fromjson-"));
    const file = path.join(dir, "payload.json");
    fs.writeFileSync(file, JSON.stringify(obj));
    return file;
  };

  test("ohje update: edit mode rejects --from-json exactly as it rejects --body", async () => {
    // --from-json is --body's file twin and sets the same fields, but it was
    // missing from the edit-mode exclusion list, so it sailed past the guard and
    // was silently ignored where --body exits 4 — the silent-drop class the
    // from-json helper exists to prevent (fb#1189).
    const withBody = await runArgv(
      ["ohje", "update", "testHelp", "--append", " x", "--reason", "r", "--body", '{"htmltext":"y"}'],
      OFFLINE
    );
    const withFile = await runArgv(
      ["ohje", "update", "testHelp", "--append", " x", "--reason", "r", "--from-json", jsonFile({ htmltext: "y" })],
      OFFLINE
    );
    expect(withBody.exitCode).toBe(4);
    expect(withFile.exitCode).toBe(4);
    expect(withFile.stderr).toContain("cannot be combined");
    expect(withFile.stderr).toContain("--from-json");
  });

  test("a required flag arriving EMPTY is reported as empty, not as missing", async () => {
    // "missing" + "supply it as a key in --from-json" told a caller who had done
    // exactly that to do it again; the value arrived, it was just blank (fb#1187).
    const r = await runArgv(
      ["notification", "fcm", "send", "--from-json", jsonFile({ person: "10", title: "", body: "b" })],
      OFFLINE
    );
    expect(r.exitCode).toBe(4);
    const env = JSON.parse(r.stderr.trim());
    const problem = env.problems.find((p: { flag: string }) => p.flag === "--title");
    expect(problem.issue).toBe("invalid");
    expect(problem.got).toBe("");
    expect(problem.remedy).toContain("empty");
  });

  test("a required flag that is genuinely absent still reports missing", async () => {
    const r = await runArgv(["notification", "fcm", "send", "--person", "10", "--body", "b"], OFFLINE);
    expect(r.exitCode).toBe(4);
    const env = JSON.parse(r.stderr.trim());
    expect(env.problems.find((p: { flag: string }) => p.flag === "--title").issue).toBe("missing");
  });
});
