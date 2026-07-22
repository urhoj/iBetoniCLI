import { describe, test, expect, vi } from "vitest";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList, runReferenceDetailLint } from "../../src/reference/detail.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import type { ApiClient } from "../../src/api/client.js";

type MockClient = ApiClient & Record<"get" | "put" | "post" | "delete" | "getCurrentToken", ReturnType<typeof vi.fn>>;

function client(over: Record<string, unknown> = {}): MockClient {
  return { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(), ...over } as unknown as MockClient;
}

describe("ib reference detail (DB-backed)", () => {
  test("get fetches /api/cli/command-catalog/:command", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ command: "ib keikka list", detail: "d", hint: "h" }) });
    const out = await runReferenceDetail(c, ["keikka", "list"], "developer");
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20keikka%20list");
    expect(out.detail).toBe("d");
  });
  test("set PUTs summary+detail", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["keikka", "list"], { summary: "s", detail: "d" });
    expect(c.put).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20keikka%20list", { summary: "s", detail: "d" }, expect.anything());
  });
  test("list passes stalest", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10);
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10");
  });

  test("set sends aiConfidence + needsHumanReview when provided", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["keikka", "list"], { summary: "s", aiConfidence: 80, needsHumanReview: true });
    expect(c.put).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20keikka%20list",
      { summary: "s", aiConfidence: 80, needsHumanReview: true },
      expect.anything()
    );
  });

  test("set omits aiConfidence key when not provided (backend resets)", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({}) });
    await runReferenceDetailSet(c, ["keikka", "list"], { summary: "s" });
    const body = c.put.mock.calls[0][1];
    expect("aiConfidence" in body).toBe(false);
    expect("needsHumanReview" in body).toBe(false);
  });

  test("list passes needsReview + maxConfidence", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, undefined, false, true, 90);
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10&needsReview=1&maxConfidence=90");
  });

  describe("lint (orphan catalog rows)", () => {
    const live = COMMAND_SPECS[0].command; // a guaranteed-live command key

    test("flags only rows whose command is not a live spec", async () => {
      const c = client({
        get: vi.fn().mockResolvedValue({
          items: [
            { command: live, summary: "s1" },
            { command: "ib customer prh", summary: "stale alias" },
            { command: "ib weather forecast", summary: null },
          ],
          count: 3,
        }),
      });
      const res = await runReferenceDetailLint(c);
      expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog");
      expect(res.count).toBe(2);
      expect(res.items.map((f) => f.command).sort()).toEqual(["ib customer prh", "ib weather forecast"]);
      const prh = res.items.find((f) => f.command === "ib customer prh")!;
      expect(prh.severity).toBe("warn");
      expect(prh.kind).toBe("orphan");
      expect(prh.summary).toBe("stale alias");
      // hint carries the ready-to-run prune command with the `ib ` prefix stripped
      expect(prh.hint).toContain("reference detail delete customer prh");
    });

    test("clean catalog yields zero findings", async () => {
      const c = client({ get: vi.fn().mockResolvedValue({ items: [{ command: live }], count: 1 }) });
      const res = await runReferenceDetailLint(c);
      expect(res).toEqual({ items: [], count: 0 });
    });
  });
});
