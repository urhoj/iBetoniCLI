import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runKeikkaIntakeResolve,
  runKeikkaIntakeCommit,
} from "../../src/commands/keikka/index.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { isWriteSpec } from "../../src/reference/commandsList.js";

const mockClient = mockApiClient();

describe("ib keikka intake resolve/commit", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("runKeikkaIntakeResolve POSTs to /api/cli/keikka/intake/resolve", async () => {
    mockClient.post.mockResolvedValueOnce({ orders: [] });
    const body = { orders: [] };
    const result = await runKeikkaIntakeResolve(mockClient, body, {});
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/intake/resolve",
      body,
      { headers: {} }
    );
    expect(result).toEqual({ orders: [] });
  });

  test("runKeikkaIntakeCommit POSTs to /api/cli/keikka/intake/commit and forwards write flags", async () => {
    mockClient.post.mockResolvedValueOnce({ keikkaId: 555, ref: "1" });
    const body = { order: {} };
    const result = await runKeikkaIntakeCommit(mockClient, body, {
      reason: "AI intake",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/intake/commit",
      body,
      { headers: { "X-Action-Reason": "AI intake" } }
    );
    expect((result as { keikkaId: number }).keikkaId).toBe(555);
  });
});

// The /ai loop's iteration budget depends on `resolve` classifying as a READ
// (no confirmation card) and `commit` classifying as a WRITE (one confirm
// card). That classification is `isWriteSpec = mutates ?? !!writeFlags`
// (src/reference/commandsList.ts) — a `??` fallthrough, so flipping
// `mutates: false` to `true` on the resolve spec (or adding `writeFlags` to
// it) silently breaks the whole design with no effect on the rendered help
// snapshot (formatHelp's WRITE-SAFETY block keys off `writeFlags` alone).
// These assertions read the REAL COMMAND_SPECS catalogue, not a fixture, so a
// regression here fails this test directly instead of only showing up as a
// confirm card appearing/disappearing in a live /ai session.
describe("ib keikka intake — write classification pinned in COMMAND_SPECS", () => {
  const resolveSpec = COMMAND_SPECS.find(
    (s) => s.command === "ib keikka intake resolve"
  );
  const commitSpec = COMMAND_SPECS.find(
    (s) => s.command === "ib keikka intake commit"
  );

  test("resolve is classified READ: mutates:false, no writeFlags, isWriteSpec:false", () => {
    expect(resolveSpec).toBeDefined();
    expect(resolveSpec!.mutates).toBe(false);
    expect("writeFlags" in resolveSpec!).toBe(false);
    expect(isWriteSpec(resolveSpec!)).toBe(false);
  });

  test("commit is classified WRITE: writeFlags:true, isWriteSpec:true", () => {
    expect(commitSpec).toBeDefined();
    expect(commitSpec!.writeFlags).toBe(true);
    expect(isWriteSpec(commitSpec!)).toBe(true);
  });
});
