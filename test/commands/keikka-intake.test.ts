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

  // `read: true` is not cosmetic and not a duplicate of the spec assertions
  // below — it is the OTHER half of the same contract, enforced in a different
  // process layer. The spec says `mutates: false`, which makes the backend
  // catalog classify resolve as a read, which makes the /ai loop run the child
  // with `readOnly: true` (askWithFunctions2.js) → `IB_READ_ONLY=1`. The CLI's
  // own write-lock in src/api/client.ts then refuses every non-GET that is not
  // `meta` or `read`, throwing READ_ONLY_BLOCKED with exit 3 BEFORE the request
  // leaves the process. So a resolve without `read: true` cannot run in the very
  // loop it was built for: step 1 of the feature fails 100% of the time.
  //
  // It is untestable end-to-end from here (the failure needs the deployed
  // catalog plus a live /ai turn), and it is currently INVISIBLE in practice
  // only because puminet5api's vendored betonicli pointer is stale, so the
  // command is absent from the catalog and classification fails closed to
  // `write: true` — i.e. bumping that pointer, which shipping this feature
  // REQUIRES, is what arms the bug. Hence a unit assertion on the exact opts.
  test("runKeikkaIntakeResolve POSTs to /api/cli/keikka/intake/resolve as a READ", async () => {
    mockClient.post.mockResolvedValueOnce({ orders: [] });
    const body = { orders: [] };
    const result = await runKeikkaIntakeResolve(mockClient, body, {});
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/intake/resolve",
      body,
      { headers: {}, read: true }
    );
    expect(result).toEqual({ orders: [] });
  });

  // Every other read-over-POST in this CLI tags itself the same way
  // (`ib person search`, `ib worksite search`, `ib jerry checkAddress`,
  // `ib dev schema query`). Assert the flag survives alongside write-flag
  // headers too, so a future edit cannot drop it while the headers keep passing.
  test("runKeikkaIntakeResolve keeps read: true when write flags are present", async () => {
    mockClient.post.mockResolvedValueOnce({ orders: [] });
    await runKeikkaIntakeResolve(mockClient, { orders: [] }, { reason: "AI intake" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/intake/resolve",
      { orders: [] },
      { headers: { "X-Action-Reason": "AI intake" }, read: true }
    );
  });

  // The mirror-image assertion: commit is a real write and must NEVER carry
  // `read: true`, which would punch it straight through the read-only lock.
  test("runKeikkaIntakeCommit does NOT carry read: true", async () => {
    mockClient.post.mockResolvedValueOnce({ keikkaId: 1, ref: "1" });
    await runKeikkaIntakeCommit(mockClient, { order: {} }, {});
    const opts = mockClient.post.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("read");
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
