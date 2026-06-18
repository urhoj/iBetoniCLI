/**
 * Tests for the DB-backed `ib reference detail` runner.
 *
 * The old synchronous form (reading `spec.detail` from local COMMAND_SPECS) was
 * replaced in favour of a network read against /api/cli/command-catalog. These
 * tests use a mock ApiClient so no network is needed.
 */
import { describe, test, expect, vi } from "vitest";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList } from "../../src/reference/detail.js";
import { CliError } from "../../src/api/errors.js";

function client(over: Record<string, unknown> = {}) {
  return {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
    ...over,
  } as never;
}

describe("runReferenceDetail", () => {
  test("fetches /api/cli/command-catalog/:command for a known command", async () => {
    const mockResult = { command: "ib keikka latest", summary: null, detail: "Keikka = yksi betonin...", hint: "h" };
    const c = client({ get: vi.fn().mockResolvedValue(mockResult) });
    const out = await runReferenceDetail(c, ["keikka", "latest"], "developer");
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20keikka%20latest");
    expect(out.command).toBe("ib keikka latest");
    expect(out.detail).toBe("Keikka = yksi betonin...");
  });

  test("exit 5 for an unknown command (not in visible specs)", async () => {
    const c = client({ get: vi.fn() });
    try {
      await runReferenceDetail(c, ["nope", "nope"], "developer");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(5);
    }
  });

  test("hides developer-tier commands from a standard caller (fail-closed)", async () => {
    const c = client({ get: vi.fn() });
    // standard tier: developer-only commands (like schema table) are filtered by visibleSpecs → treated as unknown
    try {
      await runReferenceDetail(c, ["schema", "table"], "standard");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(5);
      expect((e as CliError).message).toMatch(/unknown command/);
    }
    // developer tier: command is visible, request goes to the network
    const devClient = client({ get: vi.fn().mockResolvedValue({ command: "ib schema table", summary: null, detail: "d", hint: "" }) });
    const result = await runReferenceDetail(devClient, ["schema", "table"], "developer");
    expect(result.detail).toBe("d");
  });

  test("runReferenceDetailSet PUTs body with write-safety headers", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["keikka", "list"], { summary: "s", detail: "d" }, { reason: "test" });
    expect((c as any).put).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20keikka%20list",
      { summary: "s", detail: "d" },
      { headers: { "X-Action-Reason": "test" } }
    );
  });

  test("runReferenceDetailList passes stalest query param", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10);
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10");
  });

  test("runReferenceDetailList omits stalest when undefined", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c);
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog");
  });

  test("runReferenceDetailList forwards the domain filter alongside stalest", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, "attachment");
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10&domain=attachment");
  });

  test("runReferenceDetailList sends domain alone when no stalest", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, undefined, "attachment");
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog?domain=attachment");
  });

  test("runReferenceDetailList appends withDetail=1 when requested", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, "attachment", true);
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10&domain=attachment&withDetail=1");
  });

  test("runReferenceDetailList omits withDetail when false (default slim shape)", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, undefined, false);
    expect((c as any).get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10");
  });
});
