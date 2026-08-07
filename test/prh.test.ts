import { describe, test, expect, vi } from "vitest";
import { mockApiClient } from "./helpers/mockClient.js";
import { runPrhById } from "../src/prh.js";

describe("runPrhById", () => {
  test("passes companySituations through", async () => {
    const client = mockApiClient({
      get: vi.fn().mockResolvedValueOnce({ data: { businessId: "0145937-9", name: "X", companySituations: [{ type: "KONKURSSI" }] } }),
    });
    const res = await runPrhById(client, "0145937-9");
    expect(res.companySituations).toEqual([{ type: "KONKURSSI" }]);
  });

  test("defaults companySituations to [] when absent", async () => {
    const client = mockApiClient({
      get: vi.fn().mockResolvedValueOnce({ data: { businessId: "0145937-9", name: "X" } }),
    });
    const res = await runPrhById(client, "0145937-9");
    expect(res.companySituations).toEqual([]);
  });
});
