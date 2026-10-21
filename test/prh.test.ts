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

  // fb#2692: near-ID input gets a format hint with the corrected ID, not a name search.
  test.each([
    ["01120389", "0112038-9"],
    ["FI01120389", "0112038-9"],
    ["0112038 9", "0112038-9"],
    ["017282446", "01728244-6"],
  ])("suggests the corrected ID for near-miss %s", async (input, fixed) => {
    const get = vi.fn();
    const err = await runPrhById(mockApiClient({ get }), input).catch((e) => e);
    expect(err.exitCode).toBe(4);
    expect(err.hint).toBe(`format is 7-8 digits, hyphen, check digit — did you mean ${fixed}?`);
    expect(get).not.toHaveBeenCalled();
  });

  // fb#2747: 1234567-8 fails the check digit (1234567-1 is valid), so no "did you mean".
  test.each(["1234567", "12345678", ""])("digit-only %j with no valid reading gets the format hint without a guess", async (input) => {
    const err = await runPrhById(mockApiClient({ get: vi.fn() }), input).catch((e) => e);
    expect(err.hint).toBe("format is 7-8 digits, hyphen, check digit, e.g. 0112038-9");
  });

  test("double quotes are dropped from the name-search hint", async () => {
    const err = await runPrhById(mockApiClient({ get: vi.fn() }), 'Foo "Bar" Oy').catch((e) => e);
    expect(err.hint).toBe('find it by name: ib opendata prh --search "Foo Bar Oy"');
  });

  test("surrounding whitespace is trimmed before the check and the request", async () => {
    const get = vi.fn().mockResolvedValue({ data: { businessId: "0112038-9", name: "X" } });
    await runPrhById(mockApiClient({ get }), " 0112038-9 ");
    expect(get).toHaveBeenCalledWith("/api/prh/company/0112038-9");
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
