import { describe, test, expect, vi } from "vitest";
import { runValidate, runValidateProfiles } from "../../src/commands/company/index.js";
import type { ApiClient } from "../../src/api/client.js";

function mockClient(getImpl: (path: string) => unknown): ApiClient {
  return {
    get: vi.fn(async (path: string) => getImpl(path)),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(() => "x.y.z"),
  } as unknown as ApiClient;
}

describe("validate", () => {
  test("runValidateProfiles wraps the profile list in a ListEnvelope", async () => {
    const rows = [{ id: "jerry", titleFi: "BetoniJerry-toimittaja", description: "x" }];
    const client = mockClient(() => rows);
    const out = await runValidateProfiles(client);
    expect(client.get).toHaveBeenCalledWith("/api/validation/profiles");
    expect(out).toEqual({ items: rows, nextCursor: null, count: 1 });
  });

  test("runValidate GETs /api/validation/:profile/:asiakasId and passes the result through", async () => {
    const result = { profile: "jerry", asiakasId: 8, ok: false, summary: {}, checks: [] };
    const client = mockClient(() => result);
    const out = await runValidate(client, "jerry", 8);
    expect(client.get).toHaveBeenCalledWith("/api/validation/jerry/8");
    expect(out).toEqual(result);
  });

  test("runValidate rejects a non-positive asiakasId with exit 4", async () => {
    const client = mockClient(() => ({}));
    await expect(runValidate(client, "jerry", 0)).rejects.toMatchObject({ exitCode: 4 });
    await expect(runValidate(client, "jerry", Number.NaN)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });
});
