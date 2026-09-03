import { describe, test, expect } from "vitest";
import { runArgv } from "../../src/runArgv.js";

// fb#1108: `ib sijainti update` gained the <sijaintiId> positional already used
// by get/set-jerry/set-public/delete, alongside the pre-existing --id flag.
// Both guards below fire BEFORE getClient()/the network call (same shape as the
// dashboard exactly-one-of guard in dashboard-leaves.test.ts), so these
// run-in-process invocations never touch the (unreachable) endpoint.
describe("ib sijainti update — positional vs --id target resolution (fb#1108)", () => {
  const opts = { token: "t", endpoint: "http://127.0.0.1:9" };

  test("<sijaintiId> and --id both given but differ -> exit 4", async () => {
    const r = await runArgv(
      ["sijainti", "update", "42", "--id", "43", "--name", "x"],
      opts
    );
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatch(/differ/i);
  });

  test("non-integer <sijaintiId> -> exit 4", async () => {
    const r = await runArgv(["sijainti", "update", "not-a-number"], opts);
    expect(r.exitCode).toBe(4);
  });
});
