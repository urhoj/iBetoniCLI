import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runKeikkaSearch } from "../../src/commands/keikka/index.js";

const mockClient = mockApiClient();

// Two rows for keikka 1 (two betoni pours) + one for keikka 2 — must dedupe.
const RAW = [
  { keikkaId: 1, keikkaOtsikko: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z", asiakasNimi: "Lujabetoni", tyomaaNimi: "Kamppi", m3: 10, osoite: "Fredrikinkatu 51", contactPerson: "Kai K", contactPhone: "0401234567", keikkaBetoniId: 11, ownerAsiakasId: 27, ownerAsiakasNimi: "Betomik Oy" },
  { keikkaId: 1, keikkaOtsikko: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z", asiakasNimi: "Lujabetoni", tyomaaNimi: "Kamppi", m3: 2.5, osoite: "Fredrikinkatu 51", contactPerson: "Kai K", contactPhone: "0401234567", keikkaBetoniId: 12, ownerAsiakasId: 27, ownerAsiakasNimi: "Betomik Oy" },
  { keikkaId: 2, keikkaOtsikko: null, pumppuAika: "2026-06-08T08:00:00.000Z", asiakasNimi: "Rudus", tyomaaNimi: null, m3: 5, osoite: null, contactPerson: null, contactPhone: null, keikkaBetoniId: 13, ownerAsiakasId: 8, ownerAsiakasNimi: "Kalle Urho Oy" },
];

describe("runKeikkaSearch", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.get.mockResolvedValue(RAW);
  });

  test("calls /api/keikka/search with searchString, ownerAsiakasId and the full-text flag", async () => {
    await runKeikkaSearch(mockClient, "kamppi", 27);
    const path = mockClient.get.mock.calls[0][0] as string;
    expect(path).toContain("/api/keikka/search?");
    expect(path).toContain("searchString=kamppi");
    expect(path).toContain("usingFullTextSearch=true");
  });

  // cl#2544 — the new backend takes the company from the JWT and ignores this parameter, but
  // it is still sent, and that is load-bearing during a deploy window: the migration adding
  // the scope filter to keikka_search_*_v2 lands BEFORE that backend, and the OLD backend
  // reads the company from the query string. Omitting it there sent @ownerAsiakasId = NULL
  // into the filter, which matched nothing and returned 0 rows — verified against production.
  test("still sends ownerAsiakasId, so an older backend can still resolve the company", async () => {
    await runKeikkaSearch(mockClient, "kamppi", 27);
    expect(mockClient.get.mock.calls[0][0] as string).toContain("ownerAsiakasId=27");
  });

  test("defaults to the active company: no scope parameter", async () => {
    await runKeikkaSearch(mockClient, "kamppi", 27);
    expect(mockClient.get.mock.calls[0][0] as string).not.toContain("scope=");
  });

  test("--all-companies asks the backend for scope=all", async () => {
    await runKeikkaSearch(mockClient, "kamppi", 27, undefined, true);
    expect(mockClient.get.mock.calls[0][0] as string).toContain("scope=all");
  });

  test("dedupes rows by keikkaId and projects the envelope", async () => {
    const env = await runKeikkaSearch(mockClient, "kamppi", 27);
    expect(env.count).toBe(2);
    expect(env.items[0]).toEqual({
      keikkaId: 1, title: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z",
      customerName: "Lujabetoni", worksiteName: "Kamppi", address: "Fredrikinkatu 51",
      contactPerson: "Kai K", contactPhone: "0401234567",
      ownerAsiakasId: 27, ownerName: "Betomik Oy",
    });
    expect(env.items[1].keikkaId).toBe(2);
    expect(env.items[1].title).toBeNull();
  });

  // Under --all-companies a hit can belong to another company; the owner is what tells you so
  // (and what predicts the 403 from `keikka copy`).
  test("carries each hit's owning company through the projection", async () => {
    const env = await runKeikkaSearch(mockClient, "kamppi", 27, undefined, true);
    expect(env.items[1].ownerAsiakasId).toBe(8);
    expect(env.items[1].ownerName).toBe("Kalle Urho Oy");
  });

  test("an older backend that sends no owner columns projects nulls, not NaN", async () => {
    mockClient.get.mockResolvedValue([{ keikkaId: 5, keikkaOtsikko: "x" }]);
    const env = await runKeikkaSearch(mockClient, "x", 27);
    expect(env.items[0].ownerAsiakasId).toBeNull();
    expect(env.items[0].ownerName).toBeNull();
  });

  test("applies the client-side limit after dedupe", async () => {
    const env = await runKeikkaSearch(mockClient, "kamppi", 27, 1);
    expect(env.count).toBe(1);
    expect(env.items[0].keikkaId).toBe(1);
  });

  test("tolerates an empty result", async () => {
    mockClient.get.mockResolvedValue([]);
    const env = await runKeikkaSearch(mockClient, "nothing", 27);
    expect(env).toEqual({ items: [], nextCursor: null, count: 0 });
  });
});
