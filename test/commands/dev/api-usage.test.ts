import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "../../helpers/mockClient.js";
import { runDevApiUsage } from "../../../src/commands/dev/api-usage/index.js";

describe("runDevApiUsage (fb#1380)", () => {
  test("GETs every service when --service is omitted", async () => {
    const client = mockApiClient({ get: vi.fn(async () => ({ items: [] })) });
    await runDevApiUsage(client);
    expect(client.get).toHaveBeenCalledWith("/api/cli/api-usage");
  });

  test("passes --service as a query param", async () => {
    const client = mockApiClient({ get: vi.fn(async () => ({ items: [] })) });
    await runDevApiUsage(client, { service: "ecofleet" });
    expect(client.get).toHaveBeenCalledWith("/api/cli/api-usage?service=ecofleet");
  });
});
