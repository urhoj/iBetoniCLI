import { describe, test, expect, vi, beforeEach } from "vitest";
import { runBuildingLookup } from "../../src/commands/building/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;
const get = () => mockClient.get as ReturnType<typeof vi.fn>;

beforeEach(() => get().mockReset());

describe("runBuildingLookup", () => {
  test("worksite → ?worksite=", async () => {
    get().mockResolvedValueOnce({ source: "worksite", found: true });
    const out = await runBuildingLookup(mockClient, { worksite: 1234 });
    expect(get()).toHaveBeenCalledWith("/api/cli/opendata/building/lookup?worksite=1234");
    expect(out).toEqual({ source: "worksite", found: true });
  });

  test("--tyomaa aliases to ?worksite=", async () => {
    get().mockResolvedValueOnce({});
    await runBuildingLookup(mockClient, { tyomaa: 99 });
    expect(get()).toHaveBeenCalledWith("/api/cli/opendata/building/lookup?worksite=99");
  });

  test("sijainti → ?sijainti=", async () => {
    get().mockResolvedValueOnce({});
    await runBuildingLookup(mockClient, { sijainti: 56 });
    expect(get()).toHaveBeenCalledWith("/api/cli/opendata/building/lookup?sijainti=56");
  });

  test("lat/lng + city → ?lat=&lng=&city=", async () => {
    get().mockResolvedValueOnce({});
    await runBuildingLookup(mockClient, { lat: 60.1699, lng: 24.9384, city: "Helsinki" });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/building/lookup?lat=60.1699&lng=24.9384&city=Helsinki"
    );
  });

  test("address is URL-encoded", async () => {
    get().mockResolvedValueOnce({});
    await runBuildingLookup(mockClient, { address: "Mannerheimintie 1, Helsinki" });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/building/lookup?address=Mannerheimintie+1%2C+Helsinki"
    );
  });
});
