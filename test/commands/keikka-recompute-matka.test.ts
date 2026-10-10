import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runKeikkaRecomputeMatka } from "../../src/commands/keikka/index.js";

const c = mockApiClient();

describe("runKeikkaRecomputeMatka (fb#1981)", () => {
  beforeEach(() => {
    c.post.mockReset();
  });

  test("single keikka posts { which } (default both) to /recompute-matka/:id", async () => {
    c.post.mockResolvedValueOnce({ matched: 1 });
    await runKeikkaRecomputeMatka(c, { keikkaId: 9001 }, {}, {});
    expect(c.post).toHaveBeenCalledWith("/api/cli/keikka/recompute-matka/9001", { which: "both" }, { headers: {} });
  });

  test("range posts { from, to, which, onlyMissing } with the write-flag headers", async () => {
    c.post.mockResolvedValueOnce({ matched: 12 });
    await runKeikkaRecomputeMatka(
      c,
      { from: "2026-10-01", to: "2026-10-31" },
      { which: "pumppu", onlyMissing: true },
      { reason: "backfill" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/keikka/recompute-matka",
      { from: "2026-10-01", to: "2026-10-31", which: "pumppu", onlyMissing: true },
      { headers: { "X-Action-Reason": "backfill" } }
    );
  });

  test("--dry-run rides the X-Dry-Run header; onlyMissing defaults to false", async () => {
    c.post.mockResolvedValueOnce({ dryRun: true });
    await runKeikkaRecomputeMatka(c, { from: "2026-10-01", to: "2026-10-02" }, { which: "betoni" }, { dryRun: true });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/keikka/recompute-matka",
      { from: "2026-10-01", to: "2026-10-02", which: "betoni", onlyMissing: false },
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test.each([
    ["keikkaId and a range", { keikkaId: 9001, from: "2026-10-01", to: "2026-10-02" }, {}, /not both/],
    ["keikkaId and only --from", { keikkaId: 9001, from: "2026-10-01" }, {}, /not both/],
    ["nothing", {}, {}, /or both --from and --to/],
    ["--from without --to", { from: "2026-10-01" }, {}, /or both --from and --to/],
    ["--to without --from", { to: "2026-10-01" }, {}, /or both --from and --to/],
    ["--only-missing with a keikkaId", { keikkaId: 9001 }, { onlyMissing: true }, /--only-missing applies only/],
    ["bad --which", { keikkaId: 9001 }, { which: "pump" }, /--which must be one of: betoni, pumppu, both/],
  ])("usage guard: %s exits 4 before any POST", async (_label, target, opts, re) => {
    await expect(runKeikkaRecomputeMatka(c, target, opts, {})).rejects.toMatchObject({ exitCode: 4, message: expect.stringMatching(re) });
    expect(c.post).not.toHaveBeenCalled();
  });
});
