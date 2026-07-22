import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";

describe("ib CLI smoke", () => {
  test("--version prints the package version", () => {
    const result = spawnSync("npx tsx src/bin/ib.ts --version", {
      encoding: "utf8",
      shell: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
