import { describe, test, expect, vi } from "vitest";
import {
  runValidateProfiles,
  runValidateCompany,
  runValidatePerson,
} from "../../src/commands/validate/index.js";
import type { ApiClient } from "../../src/api/client.js";

function mockClient(getImpl: (path: string) => unknown): ApiClient {
  return {
    get: vi.fn(async (path: string) => getImpl(path)),
    post: vi.fn(), put: vi.fn(), delete: vi.fn(),
    getCurrentToken: vi.fn(() => "x.y.z"),
  } as unknown as ApiClient;
}

describe("ib validate handlers", () => {
  test("runValidateProfiles wraps GET /api/validation/profiles in a ListEnvelope", async () => {
    const rows = [{ id: "onboarding", titleFi: "x", description: "y", entity: "person" }];
    const client = mockClient(() => rows);
    const out = await runValidateProfiles(client);
    expect(client.get).toHaveBeenCalledWith("/api/validation/profiles");
    expect(out).toEqual({ items: rows, nextCursor: null, count: 1 });
  });

  test("runValidateCompany GETs /api/validation/:profile/:asiakasId", async () => {
    const result = { entity: "company", profile: "betoni", asiakasId: 8, ok: true };
    const client = mockClient(() => result);
    const out = await runValidateCompany(client, "betoni", 8);
    expect(client.get).toHaveBeenCalledWith("/api/validation/betoni/8");
    expect(out).toEqual(result);
  });

  test("runValidatePerson GETs /api/validation/person/:profile/:asiakasId/:personId", async () => {
    const result = { entity: "person", profile: "onboarding", asiakasId: 8, personId: 10, ok: true };
    const client = mockClient(() => result);
    const out = await runValidatePerson(client, "onboarding", 8, 10);
    expect(client.get).toHaveBeenCalledWith("/api/validation/person/onboarding/8/10");
    expect(out).toEqual(result);
  });

  test("runValidateCompany rejects non-positive asiakasId with exit 4", async () => {
    const client = mockClient(() => ({}));
    await expect(runValidateCompany(client, "betoni", 0)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });

  test("runValidatePerson rejects non-positive ids with exit 4", async () => {
    const client = mockClient(() => ({}));
    await expect(runValidatePerson(client, "onboarding", 8, 0)).rejects.toMatchObject({ exitCode: 4 });
    await expect(runValidatePerson(client, "onboarding", 0, 10)).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });
});
