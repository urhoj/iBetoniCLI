/**
 * Tests for the DB-backed `ib reference detail` runner.
 *
 * The old synchronous form (reading `spec.detail` from local COMMAND_SPECS) was
 * replaced in favour of a network read against /api/cli/command-catalog. These
 * tests use a mock ApiClient so no network is needed.
 */
import { describe, test, expect, vi } from "vitest";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList, runReferenceDetailEdit } from "../../src/reference/detail.js";
import type { ApiClient } from "../../src/api/client.js";
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

  test("tolerates the leading `ib` prefix copied verbatim from `detail list` output", async () => {
    // `reference detail list` emits `command: "ib driver available"`; feeding that
    // value straight back into `get` must NOT double the prefix.
    const mockResult = { command: "ib driver available", summary: null, detail: "d", hint: "" };
    // as separate args: ["ib","driver","available"]
    const c1 = client({ get: vi.fn().mockResolvedValue(mockResult) });
    await runReferenceDetail(c1, ["ib", "driver", "available"], "developer");
    expect((c1 as any).get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20driver%20available");
    // as one quoted string: ["ib driver available"]
    const c2 = client({ get: vi.fn().mockResolvedValue(mockResult) });
    await runReferenceDetail(c2, ["ib driver available"], "developer");
    expect((c2 as any).get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20driver%20available");
    // prefix-less form still resolves to the same key
    const c3 = client({ get: vi.fn().mockResolvedValue(mockResult) });
    await runReferenceDetail(c3, ["driver", "available"], "developer");
    expect((c3 as any).get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20driver%20available");
  });

  test("normalizes the `ib` prefix on the write path too (set)", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["ib keikka list"], { summary: "s" }, { reason: "t" });
    expect((c as any).put).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20keikka%20list",
      { summary: "s" },
      { headers: { "X-Action-Reason": "t" } }
    );
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

describe("ib reference detail set — edit mode (in-field partial)", () => {
  const CURRENT = { command: "ib keikka list", summary: "Lists orders", detail: "## Keikka list\nReturns the 14 latest.", hint: "" };

  test("--replace on detail (default field) --dry-run returns a diff, no PUT", async () => {
    const c = { get: vi.fn().mockResolvedValue(CURRENT), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn().mockReturnValue("t") } as unknown as ApiClient;
    const out = await runReferenceDetailEdit(
      c, ["keikka", "list"], "detail",
      { kind: "replace", find: "14 latest", replacement: "20 latest" },
      { dryRun: true }, "developer"
    ) as Record<string, unknown>;
    expect(c.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dryRun: true, command: "ib keikka list", field: "detail", matchCount: 1 });
    expect(String(out.unified)).toContain("20 latest");
  });

  test("real edit PUTs only the edited field", async () => {
    const c = { get: vi.fn().mockResolvedValue(CURRENT), put: vi.fn().mockResolvedValue({ command: "ib keikka list" }), post: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn().mockReturnValue("t") } as unknown as ApiClient;
    await runReferenceDetailEdit(
      c, ["keikka", "list"], "summary",
      { kind: "append", text: " (cached)" },
      { reason: "tweak summary" }, "developer"
    );
    expect(c.put).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20keikka%20list",
      { summary: "Lists orders (cached)" },
      { headers: { "X-Action-Reason": "tweak summary" } }
    );
  });
});
