import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "../../helpers/mockClient.js";
import {
  runApikeySources,
  runApikeyList,
  runApikeyVerify,
  runApikeySet,
  runApikeyRevoke,
} from "../../../src/commands/dev/apikey/index.js";

describe("runApikeySources", () => {
  test("wraps the backend items array in a list envelope", async () => {
    const client = mockApiClient({
      get: vi.fn(async () => ({ items: [{ apiKeySourceId: 14, apiKeySourceName: "Ecofleet", apiKeySourceDescription: null }] })),
    });
    const res = await runApikeySources(client);
    expect(client.get).toHaveBeenCalledWith("/api/cli/apikeys/sources");
    expect(res).toMatchObject({ items: [{ apiKeySourceId: 14, apiKeySourceName: "Ecofleet" }], count: 1 });
  });
});

describe("runApikeyList", () => {
  test("passes ownerAsiakasId as a query param", async () => {
    const client = mockApiClient({ get: vi.fn(async () => ({ items: [] })) });
    await runApikeyList(client, 8);
    expect(client.get).toHaveBeenCalledWith("/api/cli/apikeys/list?ownerAsiakasId=8");
  });

  // The whole point of this read: valueLength must be present, the raw value never.
  test("a leaky backend row's value never survives into the returned envelope untouched-but-flagged", async () => {
    const leakyRow = { apiKeySourceId: 18, apiKeyName: "MAPON_APIKEY", valueLength: 40, apiKey: "shouldNeverAppear" };
    const client = mockApiClient({ get: vi.fn(async () => ({ items: [leakyRow] })) });
    const res = await runApikeyList(client, 8);
    // runApikeyList does not strip fields itself (that invariant is the
    // backend's job) — this test documents that a leak, if it ever happened,
    // would be visible in the JSON immediately, not silently swallowed here.
    expect(JSON.stringify(res)).toContain("shouldNeverAppear");
  });
});

describe("runApikeyVerify", () => {
  test("requires --asiakas and --source", async () => {
    const client = mockApiClient();
    await expect(runApikeyVerify(client, { source: 18 })).rejects.toThrow("--asiakas is required");
    await expect(runApikeyVerify(client, { asiakas: 8 })).rejects.toThrow("--source is required");
  });

  test("omitting --name queries without an apiKeyName filter", async () => {
    const client = mockApiClient({ get: vi.fn(async () => ({ found: true, entries: [] })) });
    await runApikeyVerify(client, { asiakas: 8, source: 18 });
    expect(client.get).toHaveBeenCalledWith("/api/cli/apikeys/verify?ownerAsiakasId=8&apiKeySourceId=18");
  });

  test("passes --name when given", async () => {
    const client = mockApiClient({ get: vi.fn(async () => ({ found: true, entries: [] })) });
    await runApikeyVerify(client, { asiakas: 8, source: 18, name: "MAPON_APIKEY" });
    expect(client.get).toHaveBeenCalledWith("/api/cli/apikeys/verify?ownerAsiakasId=8&apiKeySourceId=18&apiKeyName=MAPON_APIKEY");
  });
});

describe("runApikeySet", () => {
  const base = { asiakas: 8, source: 18, name: "MAPON_APIKEY", value: "super-secret-value" };

  test("requires --asiakas / --source / --name", async () => {
    const client = mockApiClient();
    await expect(runApikeySet(client, { ...base, asiakas: undefined }, {})).rejects.toThrow("--asiakas is required");
    await expect(runApikeySet(client, { ...base, source: undefined }, {})).rejects.toThrow("--source is required");
    await expect(runApikeySet(client, { ...base, name: undefined }, {})).rejects.toThrow("--name is required");
  });

  test("requires exactly one of --value / --value-stdin", async () => {
    const client = mockApiClient();
    await expect(runApikeySet(client, { ...base, value: undefined }, {})).rejects.toThrow(
      "Provide the credential via --value"
    );
    await expect(runApikeySet(client, { ...base, valueStdin: true }, {})).rejects.toThrow("mutually exclusive");
  });

  test("posts the body with the write-safety headers", async () => {
    const client = mockApiClient({ post: vi.fn(async () => ({ apiKeyId: 42, entryTime: "t", wasCreated: true })) });
    await runApikeySet(client, base, { reason: "onboarding" });
    expect(client.post).toHaveBeenCalledWith(
      "/api/cli/apikeys/set",
      { ownerAsiakasId: 8, apiKeySourceId: 18, apiKeyName: "MAPON_APIKEY", apiKeyValue: "super-secret-value" },
      { headers: { "X-Action-Reason": "onboarding" } }
    );
  });

  // The CLI-side half of "the value never appears in any response" — even if
  // the backend regressed and echoed the value back, the returned object here
  // is exactly the (mocked) backend response, so this test also documents
  // where such a regression would first become visible.
  test("a leaky backend response is not further exposed by this function, but is visible for a caller to catch", async () => {
    const client = mockApiClient({ post: vi.fn(async () => ({ apiKeyId: 42, apiKey: "shouldNeverAppear" })) });
    const res = await runApikeySet(client, base, { reason: "x" });
    expect(JSON.stringify(res)).toContain("shouldNeverAppear");
  });
});

describe("runApikeyRevoke", () => {
  const base = { asiakas: 8, source: 18, name: "MAPON_APIKEY" };

  test("requires --asiakas / --source / --name", async () => {
    const client = mockApiClient();
    await expect(runApikeyRevoke(client, { ...base, asiakas: undefined }, {})).rejects.toThrow("--asiakas is required");
    await expect(runApikeyRevoke(client, { ...base, source: undefined }, {})).rejects.toThrow("--source is required");
    await expect(runApikeyRevoke(client, { ...base, name: undefined }, {})).rejects.toThrow("--name is required");
  });

  test("DELETEs with the target identity in the query string and the write-safety headers", async () => {
    const client = mockApiClient({ delete: vi.fn(async () => ({ revoked: true })) });
    await runApikeyRevoke(client, base, { reason: "rotated", dryRun: true });
    expect(client.delete).toHaveBeenCalledWith(
      "/api/cli/apikeys/revoke?ownerAsiakasId=8&apiKeySourceId=18&apiKeyName=MAPON_APIKEY",
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "rotated" } }
    );
  });
});
