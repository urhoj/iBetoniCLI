import { describe, test, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

// Spawn the BUILT binary, not `npx tsx src/bin/ib.ts`: dist/ is committed and is
// what actually ships, and dropping npx resolution + the tsx cold compile takes
// the spawn from ~1.3s to ~0.2s. The slow path flaked under a saturated vitest
// worker pool (feedback #302) — a false CI red on unrelated PRs. `check:dist`
// separately guarantees dist matches src, so coverage is not weakened.
const IB_BIN = fileURLToPath(new URL("../dist/bin/ib.js", import.meta.url));

describe("ib CLI smoke", () => {
  test("--version prints the package version", () => {
    const result = spawnSync(process.execPath, [IB_BIN, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    // Without this the only failure output is "expected 1 to be +0", which says
    // nothing about why the spawn died.
    const detail = [
      `spawn: ${process.execPath} ${IB_BIN} --version`,
      `status=${result.status} signal=${result.signal}`,
      `error=${result.error?.message ?? "none"}`,
      `stderr=${result.stderr?.trim() || "(empty)"}`,
    ].join("\n");

    expect(result.error, detail).toBeUndefined();
    expect(result.status, detail).toBe(0);
    // The built binary reads ../package.json at runtime, so this also proves the
    // JSON import assertion survives the tsc ESM emit.
    expect(result.stdout.trim(), detail).toBe(packageJson.version);
  });

  // fb#2331: a reader that closes early (`ib … | head`) crashed Node with an
  // unhandled 'error' event (EPIPE) and a stack trace from emitStdout. The
  // ~800 KB offline `reference dump` is far larger than one pipe buffer, so
  // closing stdout after the first chunk guarantees a write into a dead pipe.
  test("a stdout reader that closes early is not a crash (EPIPE swallowed)", async () => {
    const child = spawn(process.execPath, [IB_BIN, "reference", "dump"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stderr, stderr).not.toMatch(/Unhandled 'error' event|EPIPE/);
    expect(code, stderr).toBe(0);
  }, 30_000);
});
