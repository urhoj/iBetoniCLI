import { describe, test, expect, vi } from "vitest";
import { runPrhById } from "../src/prh.js";
import type { ApiClient } from "../src/api/client.js";

describe("runPrhById", () => {
  test("passes companySituations through", async () => {
    const client = { get: vi.fn().mockResolvedValueOnce({ data: { businessId: "0145937-9", name: "X", companySituations: [{ type: "KONKURSSI" }] } }) } as unknown as ApiClient;
    const res = await runPrhById(client, "0145937-9");
    expect(res.companySituations).toEqual([{ type: "KONKURSSI" }]);
  });
});
