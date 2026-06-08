import { describe, test, expect, vi } from "vitest";
import { runVersion } from "../../src/commands/version/index.js";

/** Build a minimal Response-like stub for the injected fetch. */
function fakeResponse(opts: { ok: boolean; status: number; json?: unknown }) {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.json,
  } as unknown as Response;
}

describe("ib version — runVersion", () => {
  test("folds /api/version into a report and strips a trailing slash", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: {
          app: "puminet5api",
          version: "0.26.0",
          commit: "ca321290",
          release: "0.26.0+ca321290",
          slot: "production",
          timestamp: "2026-06-08T00:00:00.000Z",
        },
      })
    );
    const report = await runVersion({
      endpoint: "https://api.ibetoni.fi/",
      cliVersion: "1.0.1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.ibetoni.fi/api/version",
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": "ib-cli/1.0.1" }),
      })
    );
    expect(report).toEqual({
      cli: "1.0.1",
      endpoint: "https://api.ibetoni.fi/",
      reachable: true,
      server: {
        app: "puminet5api",
        version: "0.26.0",
        commit: "ca321290",
        release: "0.26.0+ca321290",
        slot: "production",
      },
    });
  });

  test("commit is null when the deployed build has no release.txt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: { app: "puminet5api", version: "0.26.0", commit: null, release: "0.26.0", slot: "localhost" },
      })
    );
    const report = await runVersion({
      endpoint: "https://x",
      cliVersion: "1.2.3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.reachable).toBe(true);
    expect(report.server?.commit).toBeNull();
    expect(report.server?.release).toBe("0.26.0");
  });

  test("non-2xx → reachable:false, server null, HTTP error, cli still reported", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 503 }));
    const report = await runVersion({
      endpoint: "https://down",
      cliVersion: "1.2.3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report).toEqual({
      cli: "1.2.3",
      endpoint: "https://down",
      reachable: false,
      server: null,
      error: "HTTP 503",
    });
  });

  test("network throw → reachable:false with the error detail", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const report = await runVersion({
      endpoint: "https://nope",
      cliVersion: "1.2.3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.reachable).toBe(false);
    expect(report.server).toBeNull();
    expect(report.error).toContain("ENOTFOUND");
  });
});
