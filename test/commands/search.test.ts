import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runUnifiedSearch,
  parseEntityFilter,
  SEARCH_ENTITIES,
  buildSearchSources,
} from "../../src/commands/search/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

// mockClient is not used directly in tests (sources stubs are injected instead),
// but it exists to satisfy the ApiClient type for buildSearchSources.
const _mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(),
  getCurrentToken: vi.fn(() => "h.e.s"),
} as unknown as ApiClient;
void _mockClient; // suppress unused-var lint

// One source stub per entity, injected so the test controls each branch.
function sources(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  return {
    customer: overrides.customer ?? (async () => [{ asiakasId: 88, asiakasNimi: "Kamppi Rakennus Oy", ytunnus: "1234567-8" }]),
    person: overrides.person ?? (async () => ({ items: [{ personId: 456, name: "Kai Kamppinen", email: null, phone: "+358401234567", asiakasId: 9 }], nextCursor: null, count: 1 })),
    worksite: overrides.worksite ?? (async () => ({ items: [{ tyomaaId: 12, name: "Kamppi", tyomaaNum: "T-12", address: "Fredrikinkatu 51", address2: null, postalCode: "00100", city: "Helsinki", formattedAddress: "Fredrikinkatu 51, Helsinki", coords: null }], nextCursor: null, count: 1 })),
    vehicle: overrides.vehicle ?? (async () => ({ items: [{ vehicleId: 53, plate: "ABC-123", name: "Kamppi-pumppu", typeName: "Pumppu" }], nextCursor: null, count: 1 })),
    keikka: overrides.keikka ?? (async () => ({ items: [{ keikkaId: 7, title: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z", customerName: "Lujabetoni", worksiteName: "Kamppi", address: null, contactPerson: null, contactPhone: null }], nextCursor: null, count: 1 })),
    // sijainti rows arrive typeName-joined from runSijaintiListJoined (unfiltered:
    // the query filter is applied client-side in the projector)
    sijainti: overrides.sijainti ?? (async () => ({ items: [
      { sijaintiId: 31, name: "Kamppi varikko", address: "Malminkatu 2", coords: null, type: 3, typeName: "Varikko", jerryActiveUntil: null },
      { sijaintiId: 32, name: "Muu asema", address: "Tie 8", coords: null, type: 2, typeName: "Jäteasema", jerryActiveUntil: null },
    ], nextCursor: null, count: 2 })),
  };
}

describe("parseEntityFilter", () => {
  test("undefined → all entities", () => {
    expect(parseEntityFilter(undefined)).toEqual([...SEARCH_ENTITIES]);
  });
  test("subset parses and preserves canonical order", () => {
    expect(parseEntityFilter("person,customer")).toEqual(["customer", "person"]);
  });
  test("unknown entity → CliError exit 4", () => {
    try {
      parseEntityFilter("customer,bogus");
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(4);
    }
  });
});

describe("runUnifiedSearch", () => {
  beforeEach(() => vi.clearAllMocks());

  test("merges all entities into uniform hits with native id fields", async () => {
    const env = await runUnifiedSearch("kamppi", sources());
    expect(env.count).toBe(6);
    expect(env.errors).toEqual([]);
    const customer = env.items.find((h) => h.entity === "customer")!;
    expect(customer).toMatchObject({ entity: "customer", id: 88, asiakasId: 88, label: "Kamppi Rakennus Oy", detail: "1234567-8" });
    const worksite = env.items.find((h) => h.entity === "worksite")!;
    expect(worksite).toMatchObject({ entity: "worksite", id: 12, tyomaaId: 12, label: "Kamppi", detail: "Fredrikinkatu 51, Helsinki" });
    const person = env.items.find((h) => h.entity === "person")!;
    expect(person).toMatchObject({ entity: "person", id: 456, personId: 456, label: "Kai Kamppinen", detail: "+358401234567" });
    const vehicle = env.items.find((h) => h.entity === "vehicle")!;
    expect(vehicle).toMatchObject({ entity: "vehicle", id: 53, vehicleId: 53, label: "ABC-123 Kamppi-pumppu", detail: "Pumppu" });
    const keikka = env.items.find((h) => h.entity === "keikka")!;
    expect(keikka).toMatchObject({ entity: "keikka", id: 7, keikkaId: 7, label: "Kamppi valu", detail: "2026-06-09T07:00:00.000Z · Lujabetoni" });
    const sijainti = env.items.find((h) => h.entity === "sijainti")!;
    expect(sijainti).toMatchObject({ entity: "sijainti", id: 31, sijaintiId: 31, label: "Kamppi varikko", detail: "Varikko · Malminkatu 2" });
  });

  test("prefix matches order before non-prefix; then entity group order", async () => {
    const env = await runUnifiedSearch("kamppi", sources());
    const labels = env.items.map((h) => `${h.entity}:${h.label}`);
    // Prefix tier: customer "Kamppi Rakennus Oy", worksite "Kamppi", keikka "Kamppi valu",
    // sijainti "Kamppi varikko" start with "kamppi"
    // Non-prefix tier: person "Kai Kamppinen", vehicle "ABC-123 Kamppi-pumppu" do not start with "kamppi"
    // Within each tier: canonical entity order customer→worksite→person→vehicle→keikka→sijainti
    expect(labels).toEqual([
      "customer:Kamppi Rakennus Oy",
      "worksite:Kamppi",
      "keikka:Kamppi valu",
      "sijainti:Kamppi varikko",
      "person:Kai Kamppinen",
      "vehicle:ABC-123 Kamppi-pumppu",
    ]);
  });

  test("sijainti rows are filtered client-side against the query, incl. typeName", async () => {
    const env = await runUnifiedSearch("jäteasema", sources(), ["sijainti"]);
    // only "Muu asema" matches (typeName Jäteasema); "Kamppi varikko" does not
    expect(env.items).toHaveLength(1);
    expect(env.items[0]).toMatchObject({ entity: "sijainti", id: 32, label: "Muu asema", detail: "Jäteasema · Tie 8" });
  });

  test("sijainti hits are sliced to the per-entity limit", async () => {
    const env = await runUnifiedSearch("a", sources(), ["sijainti"], 1);
    // both stub rows match "a" — limit 1 keeps only the first
    expect(env.items).toHaveLength(1);
  });

  test("vehicle rows are defensively filtered against the query (deploy-gate guard)", async () => {
    const env = await runUnifiedSearch("kamppi", sources({
      vehicle: async () => ({ items: [
        { vehicleId: 53, plate: "ABC-123", name: "Kamppi-pumppu", typeName: "Pumppu" },
        { vehicleId: 54, plate: "XYZ-999", name: "Toinen auto", typeName: "Pumppu" },
      ], nextCursor: null, count: 2 }),
    }));
    const vehicles = env.items.filter((h) => h.entity === "vehicle");
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].id).toBe(53);
  });

  test("a failing entity lands in errors[], others survive", async () => {
    const env = await runUnifiedSearch("kamppi", sources({
      keikka: async () => { throw new CliError("permission denied", 403, null, 3); },
    }));
    expect(env.count).toBe(5);
    expect(env.errors).toEqual([{ entity: "keikka", message: "permission denied" }]);
  });

  test("all entities failing throws the first failure", async () => {
    const boom = async () => { throw new CliError("nope", 403, null, 3); };
    await expect(
      runUnifiedSearch("kamppi", sources({ customer: boom, person: boom, worksite: boom, vehicle: boom, keikka: boom, sijainti: boom }))
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  test("entity subset only invokes selected sources", async () => {
    const spy = vi.fn(async () => []);
    const env = await runUnifiedSearch("kamppi", { ...sources(), person: spy }, ["customer"]);
    expect(spy).not.toHaveBeenCalled();
    expect(env.items.every((h) => h.entity === "customer")).toBe(true);
  });
});

describe("ib search --my-companies wiring", () => {
  test("buildSearchSources forwards myCompanies to customer/worksite/person, NOT vehicle/keikka/sijainti", async () => {
    const calls: Record<string, boolean> = {};
    const client = {
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/asiakas/search")) calls.customer = path.includes("myCompanies=1");
        if (path.includes("/api/cli/person/search")) calls.person = true;
        if (path.includes("/api/cli/vehicle/list")) calls.vehicleHadMy = path.includes("myCompanies");
        if (path.includes("/api/geocode/sijaintiTypes")) return [];
        if (path.includes("/api/cli/sijainti/list")) {
          calls.sijaintiAtCap = path.includes("limit=500") && !path.includes("myCompanies");
          return { items: [], nextCursor: null, count: 0 };
        }
        return path.includes("vehicle") ? { items: [], nextCursor: null, count: 0 } : [];
      }),
      post: vi.fn(async (_p: string, body: Record<string, unknown>) => {
        calls.worksite = body?.myCompanies === true;
        return [];
      }),
      getCurrentToken: vi.fn(() => "h.e.s"),
    } as unknown as ApiClient;

    const srcs = buildSearchSources(client, "x", 5, true /* myCompanies */);
    await srcs.customer();
    await srcs.worksite();
    await srcs.person();
    await srcs.vehicle();
    await srcs.sijainti();

    expect(calls.customer).toBe(true);
    expect(calls.worksite).toBe(true);
    expect(calls.person).toBe(true);          // person uses the cross-company /api/cli/person/search
    expect(calls.vehicleHadMy).toBe(false);   // vehicle ignores myCompanies
    expect(calls.sijaintiAtCap).toBe(true);   // sijainti fetches the joined list at the 500 cap, active company only
  });
});
