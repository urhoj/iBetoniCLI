/**
 * Tests for the DB-backed `ib reference detail` runner.
 *
 * The old synchronous form (reading `spec.detail` from local COMMAND_SPECS) was
 * replaced in favour of a network read against /api/cli/command-catalog. These
 * tests use a mock ApiClient so no network is needed.
 */
import { describe, test, expect, vi } from "vitest";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList, runReferenceDetailEdit, runReferenceDetailDelete } from "../../src/reference/detail.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

type MockClient = ApiClient & Record<"get" | "put" | "post" | "delete" | "getCurrentToken", ReturnType<typeof vi.fn>>;

function client(over: Record<string, unknown> = {}): MockClient {
  return {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
    ...over,
  } as unknown as MockClient;
}

describe("runReferenceDetail", () => {
  test("fetches /api/cli/command-catalog/:command for a known command", async () => {
    const mockResult = { command: "ib keikka latest", summary: null, detail: "Keikka = yksi betonin...", hint: "h" };
    const c = client({ get: vi.fn().mockResolvedValue(mockResult) });
    const out = await runReferenceDetail(c, ["keikka", "latest"], "developer");
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20keikka%20latest");
    expect(out.command).toBe("ib keikka latest");
    expect(out.detail).toBe("Keikka = yksi betonin...");
  });

  test("tolerates the leading `ib` prefix copied verbatim from `detail list` output", async () => {
    // `reference detail list` emits `command: "ib vehicle driver available"`; feeding
    // that value straight back into `get` must NOT double the prefix.
    const mockResult = { command: "ib vehicle driver available", summary: null, detail: "d", hint: "" };
    // as separate args: ["ib","vehicle","driver","available"]
    const c1 = client({ get: vi.fn().mockResolvedValue(mockResult) });
    await runReferenceDetail(c1, ["ib", "vehicle", "driver", "available"], "developer");
    expect(c1.get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20vehicle%20driver%20available");
    // as one quoted string: ["ib vehicle driver available"]
    const c2 = client({ get: vi.fn().mockResolvedValue(mockResult) });
    await runReferenceDetail(c2, ["ib vehicle driver available"], "developer");
    expect(c2.get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20vehicle%20driver%20available");
    // prefix-less form still resolves to the same key
    const c3 = client({ get: vi.fn().mockResolvedValue(mockResult) });
    await runReferenceDetail(c3, ["vehicle", "driver", "available"], "developer");
    expect(c3.get).toHaveBeenCalledWith("/api/cli/command-catalog/ib%20vehicle%20driver%20available");
  });

  test("normalizes the `ib` prefix on the write path too (set)", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["ib keikka list"], { summary: "s" }, { reason: "t" });
    expect(c.put).toHaveBeenCalledWith(
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
    // developer tier: command is visible under ib dev schema table, request goes to the network
    const devClient = client({ get: vi.fn().mockResolvedValue({ command: "ib dev schema table", summary: null, detail: "d", hint: "" }) });
    const result = await runReferenceDetail(devClient, ["dev", "schema", "table"], "developer");
    expect(result.detail).toBe("d");
  });

  test("runReferenceDetailSet PUTs body with write-safety headers", async () => {
    const c = client({ put: vi.fn().mockResolvedValue({ command: "ib keikka list", runs: 1 }) });
    await runReferenceDetailSet(c, ["keikka", "list"], { summary: "s", detail: "d" }, { reason: "test" });
    expect(c.put).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20keikka%20list",
      { summary: "s", detail: "d" },
      { headers: { "X-Action-Reason": "test" } }
    );
  });

  test("runReferenceDetailList passes stalest query param", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10);
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10");
  });

  test("runReferenceDetailList omits stalest when undefined", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c);
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog");
  });

  test("runReferenceDetailList forwards the domain filter alongside stalest", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, "attachment");
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10&domain=attachment");
  });

  test("runReferenceDetailList sends domain alone when no stalest", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, undefined, "attachment");
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?domain=attachment");
  });

  test("runReferenceDetailList appends withDetail=1 when requested", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, "attachment", true);
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10&domain=attachment&withDetail=1");
  });

  test("runReferenceDetailList omits withDetail when false (default slim shape)", async () => {
    const c = client({ get: vi.fn().mockResolvedValue({ items: [], count: 0 }) });
    await runReferenceDetailList(c, 10, undefined, false);
    expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog?stalest=10");
  });

  describe("client-side discovery filters (fb#164)", () => {
    // A mixed catalog: `ib keikka list`/`ib keikka latest` are live specs; the two
    // `ib dev bug *` keys are orphans (the group was removed — fb#134).
    const CATALOG = {
      items: [
        { command: "ib keikka list", summary: "Lists orders", lastReviewed: null, runs: 9 },
        { command: "ib keikka latest", summary: "Latest order", lastReviewed: null, runs: 4 },
        { command: "ib dev bug create", summary: "orphan", lastReviewed: null, runs: 1 },
        { command: "ib dev bug list", summary: "orphan", lastReviewed: null, runs: 0 },
      ],
      count: 4,
    };

    test("no filter passes the server response through untouched", async () => {
      const c = client({ get: vi.fn().mockResolvedValue(CATALOG) });
      const out = await runReferenceDetailList(c);
      expect(out).toBe(CATALOG);
      expect(c.get).toHaveBeenCalledWith("/api/cli/command-catalog");
    });

    test("--search keeps only rows whose command PATH contains the substring (case-insensitive) and recomputes count", async () => {
      const c = client({ get: vi.fn().mockResolvedValue(CATALOG) });
      const out = await runReferenceDetailList(c, undefined, undefined, false, false, undefined, "DEV BUG");
      expect(out.items.map((r) => r.command)).toEqual(["ib dev bug create", "ib dev bug list"]);
      expect(out.count).toBe(2);
    });

    test("--orphans keeps only rows whose command is absent from the live spec catalogue", async () => {
      const c = client({ get: vi.fn().mockResolvedValue(CATALOG) });
      const out = await runReferenceDetailList(c, undefined, undefined, false, false, undefined, undefined, true);
      expect(out.items.map((r) => r.command)).toEqual(["ib dev bug create", "ib dev bug list"]);
      expect(out.count).toBe(2);
      // live commands survive the round-trip and are NOT flagged as orphans
      expect(out.items.some((r) => r.command === "ib keikka list")).toBe(false);
    });

    test("--search and --orphans compose (AND)", async () => {
      const c = client({ get: vi.fn().mockResolvedValue(CATALOG) });
      const out = await runReferenceDetailList(c, undefined, undefined, false, false, undefined, "create", true);
      expect(out.items.map((r) => r.command)).toEqual(["ib dev bug create"]);
      expect(out.count).toBe(1);
    });
  });
});

describe("runReferenceDetailDelete", () => {
  test("DELETEs the exact key with the write-safety reason header", async () => {
    const c = client({ delete: vi.fn().mockResolvedValue({ deleted: 1 }) });
    const out = await runReferenceDetailDelete(c, ["ai", "conversation"], { reason: "orphan cleanup" });
    expect(c.delete).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20ai%20conversation",
      { headers: { "X-Action-Reason": "orphan cleanup" } }
    );
    expect(out).toEqual({ deleted: 1 });
  });

  test("targets ORPHAN keys that are NOT in the live catalogue (no exit 5 gate)", async () => {
    // `ai conversation` no longer resolves as a command — get/set would exit 5,
    // but delete must reach it so the orphan row can be pruned.
    const c = client({ delete: vi.fn().mockResolvedValue({ deleted: 1 }) });
    await runReferenceDetailDelete(c, ["ib", "ai", "conversation"], { reason: "r" });
    expect(c.delete).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20ai%20conversation",
      { headers: { "X-Action-Reason": "r" } }
    );
  });

  test("maps --dry-run to the X-Dry-Run header", async () => {
    const c = client({ delete: vi.fn().mockResolvedValue({ dryRun: true, wouldDelete: { command: "ib ai conversation", exists: true } }) });
    await runReferenceDetailDelete(c, ["ai conversation"], { dryRun: true });
    expect(c.delete).toHaveBeenCalledWith(
      "/api/cli/command-catalog/ib%20ai%20conversation",
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("exit 4 on an empty command path", async () => {
    const c = client({ delete: vi.fn() });
    await expect(runReferenceDetailDelete(c, ["ib"], { reason: "r" })).rejects.toMatchObject({ exitCode: 4 });
    expect(c.delete).not.toHaveBeenCalled();
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
    expect(c.put).toHaveBeenCalledTimes(1);
  });
});
