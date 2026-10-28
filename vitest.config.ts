import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // fb#1465: buildProgram() imports ~40 command modules; under parallel load from other
    // sessions that crossed the 5 s default and the suite flaked (a timeout, not a logic bug).
    testTimeout: 30_000,
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
