import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
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
});
