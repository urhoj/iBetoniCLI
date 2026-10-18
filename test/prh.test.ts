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

  // fb#2685: a company NAME used to reach the backend and come back as a bare format error.
  test("refuses a non-business-ID locally and points at the name search", async () => {
    const get = vi.fn();
    const err = await runPrhById(mockApiClient({ get }), "SRV Rakennus Oy").catch((e) => e);
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain("not a business ID");
    expect(err.hint).toBe('find it by name: ib opendata prh --search "SRV Rakennus Oy"');
    expect(get).not.toHaveBeenCalled();
  });

  test("accepts the backend's 7- and 8-digit forms", async () => {
    const get = vi.fn().mockResolvedValue({ data: { businessId: "x", name: "X" } });
    await runPrhById(mockApiClient({ get }), "1728244-6");
    await runPrhById(mockApiClient({ get }), "01728244-6");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("defaults companySituations to [] when absent", async () => {
    const client = mockApiClient({
      get: vi.fn().mockResolvedValueOnce({ data: { businessId: "0145937-9", name: "X" } }),
    });
    const res = await runPrhById(client, "0145937-9");
    expect(res.companySituations).toEqual([]);
  });
});
