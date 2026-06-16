import { describe, test, expect, vi } from "vitest";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList } from "../../src/reference/detail.js";

function client(over: Record<string, unknown> = {}) {
  return { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(), ...over } as never;
}

describe("ib reference detail (DB-backed)", () => {
  test("get fetches /api/cli/command-catalog/:command", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ command: "ib keikka list", detail: "d", hint: "h" }) });
    const out = await runReferenceDetail(c, ["keikka", "list"], "developer");
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20keikka%20list");
    expect(out.detail).toBe("d");
  });
  test("set PUTs summary+detail", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["keikka", "list"], { summary: "s", detail: "d" });
    expect((c as any).put).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20keikka%20list", { summary: "s", detail: "d" }, expect.anything());
  });
  test("list passes stalest", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10);
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10");
  });
});
