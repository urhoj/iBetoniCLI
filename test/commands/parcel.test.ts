import { describe, test, expect, vi, beforeEach } from "vitest";
import { runParcelLookup } from "../../src/commands/parcel/index.js";
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

describe("runParcelLookup", () => {
  test("kiinteistotunnus → ?kiinteistotunnus=", async () => {
    get().mockResolvedValueOnce({ found: true });
    const out = await runParcelLookup(mockClient, { kiinteistotunnus: "092-014-0202-0001" });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/parcel/lookup?kiinteistotunnus=092-014-0202-0001"
    );
    expect(out).toEqual({ found: true });
  });

  test("14-digit kiinteistotunnus passes through", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, { kiinteistotunnus: "92742200030051" });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/parcel/lookup?kiinteistotunnus=92742200030051"
    );
  });

  test("worksite → ?worksite=", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, { worksite: 1234 });
    expect(get()).toHaveBeenCalledWith("/api/cli/opendata/parcel/lookup?worksite=1234");
  });

  test("--tyomaa aliases to ?worksite=", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, { tyomaa: 99 });
    expect(get()).toHaveBeenCalledWith("/api/cli/opendata/parcel/lookup?worksite=99");
  });

  test("sijainti → ?sijainti=", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, { sijainti: 56 });
    expect(get()).toHaveBeenCalledWith("/api/cli/opendata/parcel/lookup?sijainti=56");
  });

  test("lat/lng → ?lat=&lng=", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, { lat: 60.272, lng: 24.8062 });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/parcel/lookup?lat=60.272&lng=24.8062"
    );
  });

  test("address is URL-encoded", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, { address: "Sarkatie 7, Vantaa" });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/parcel/lookup?address=Sarkatie+7%2C+Vantaa"
    );
  });
});
