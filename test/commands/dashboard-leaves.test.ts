import { describe, test, expect, vi, beforeEach } from "vitest";

// Replace the shared orchestrator with a mock so `runWorksiteDashboard` /
// `runSijaintiDashboard` can be tested as thin forwarding wrappers (the
// orchestrator itself — point resolution + the 7-panel fan-out — is already
// covered by src/commands/_shared/__tests__/addressDashboard.test.ts).
vi.mock("../../src/commands/_shared/addressDashboard.js", () => ({
  runAddressDashboard: vi.fn(),
}));

import { runAddressDashboard } from "../../src/commands/_shared/addressDashboard.js";
import { runWorksiteDashboard } from "../../src/commands/worksite/index.js";
import { runSijaintiDashboard } from "../../src/commands/sijainti/index.js";
import { runArgv } from "../../src/runArgv.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const mockedDashboard = vi.mocked(runAddressDashboard);

beforeEach(() => {
  mockedDashboard.mockReset();
});

describe("runWorksiteDashboard", () => {
  test("forwards { tyomaaId } to runAddressDashboard when no address is given", async () => {
    mockedDashboard.mockResolvedValueOnce({ point: null, address: null } as never);
    await runWorksiteDashboard(mockClient, { tyomaaId: 42 });
    expect(mockedDashboard).toHaveBeenCalledWith(mockClient, { tyomaaId: 42 });
  });

  test("forwards { address } (address wins over an incidentally-present tyomaaId)", async () => {
    mockedDashboard.mockResolvedValueOnce({
      point: null,
      address: "Oraspolku 2, Helsinki",
    } as never);
    await runWorksiteDashboard(mockClient, {
      tyomaaId: 42,
      address: "Oraspolku 2, Helsinki",
    });
    expect(mockedDashboard).toHaveBeenCalledWith(mockClient, {
      address: "Oraspolku 2, Helsinki",
    });
  });

  test("returns whatever runAddressDashboard resolves, unchanged", async () => {
    const report = { point: { lat: 1, lng: 2 }, address: null };
    mockedDashboard.mockResolvedValueOnce(report as never);
    await expect(runWorksiteDashboard(mockClient, { tyomaaId: 7 })).resolves.toBe(report);
  });
});

describe("runSijaintiDashboard", () => {
  test("forwards { sijaintiId } to runAddressDashboard when no address is given", async () => {
    mockedDashboard.mockResolvedValueOnce({ point: null, address: null } as never);
    await runSijaintiDashboard(mockClient, { sijaintiId: 56 });
    expect(mockedDashboard).toHaveBeenCalledWith(mockClient, { sijaintiId: 56 });
  });

  test("forwards { address } when given", async () => {
    mockedDashboard.mockResolvedValueOnce({ point: null, address: "x" } as never);
    await runSijaintiDashboard(mockClient, { address: "x" });
    expect(mockedDashboard).toHaveBeenCalledWith(mockClient, { address: "x" });
  });

  test("returns whatever runAddressDashboard resolves, unchanged", async () => {
    const report = { point: { lat: 3, lng: 4 }, address: null };
    mockedDashboard.mockResolvedValueOnce(report as never);
    await expect(runSijaintiDashboard(mockClient, { sijaintiId: 8 })).resolves.toBe(report);
  });
});

describe("ib worksite dashboard / ib sijainti dashboard — exactly-one CLI validation (exit 4)", () => {
  // The exactly-one-of guard runs BEFORE getClient()/the network call, so
  // these run-in-process invocations never touch the (unreachable) endpoint.
  const opts = { token: "t", endpoint: "http://127.0.0.1:9" };

  test("worksite dashboard: neither <tyomaaId> nor --address -> exit 4", async () => {
    const r = await runArgv(["worksite", "dashboard"], opts);
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatch(/exactly one/i);
  });

  test("worksite dashboard: both <tyomaaId> and --address -> exit 4", async () => {
    const r = await runArgv(["worksite", "dashboard", "5", "--address", "Oraspolku 2"], opts);
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatch(/not both/i);
  });

  test("worksite dashboard: non-integer <tyomaaId> -> exit 4", async () => {
    const r = await runArgv(["worksite", "dashboard", "not-a-number"], opts);
    expect(r.exitCode).toBe(4);
  });

  test("sijainti dashboard: neither <sijaintiId> nor --address -> exit 4", async () => {
    const r = await runArgv(["sijainti", "dashboard"], opts);
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatch(/exactly one/i);
  });

  test("sijainti dashboard: both <sijaintiId> and --address -> exit 4", async () => {
    const r = await runArgv(["sijainti", "dashboard", "5", "--address", "Oraspolku 2"], opts);
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stderr).error).toMatch(/not both/i);
  });

  test("sijainti dashboard: non-integer <sijaintiId> -> exit 4", async () => {
    const r = await runArgv(["sijainti", "dashboard", "not-a-number"], opts);
    expect(r.exitCode).toBe(4);
  });
});
