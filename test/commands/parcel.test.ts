import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runParcelLookup } from "../../src/commands/parcel/index.js";

const mockClient = mockApiClient();
const get = () => mockClient.get;

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

  test("--with-buildings adds withBuildings=1", async () => {
    get().mockResolvedValueOnce({});
    await runParcelLookup(mockClient, {
      kiinteistotunnus: "09201402020001",
      withBuildings: true,
    });
    expect(get()).toHaveBeenCalledWith(
      "/api/cli/opendata/parcel/lookup?kiinteistotunnus=09201402020001&withBuildings=1"
    );
  });
});
