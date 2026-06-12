import { describe, test, expect, vi } from "vitest";
import { resolveActiveOwnerAsiakasId } from "../src/owner.js";
import type { ApiClient } from "../src/api/client.js";

function clientReturning(value: unknown): ApiClient {
  return {
    get: vi.fn().mockResolvedValue(value),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
}

describe("resolveActiveOwnerAsiakasId", () => {
  test("returns currentCompanyId from /api/company-selection/available", async () => {
    const client = clientReturning({ currentCompanyId: 27 });
    await expect(resolveActiveOwnerAsiakasId(client)).resolves.toBe(27);
    expect(client.get).toHaveBeenCalledWith("/api/company-selection/available");
  });

  test("throws a clear error with the default --owner hint when unresolvable", async () => {
    const client = clientReturning({});
    await expect(resolveActiveOwnerAsiakasId(client)).rejects.toThrow(
      "could not resolve active company — run `ib auth switch`, or pass --owner"
    );
  });

  test("a call-site hint replaces the default escape hatch in the message", async () => {
    const client = clientReturning({ currentCompanyId: 0 });
    await expect(
      resolveActiveOwnerAsiakasId(client, "run `ib auth switch`")
    ).rejects.toThrow("could not resolve active company — run `ib auth switch`");
  });
});
