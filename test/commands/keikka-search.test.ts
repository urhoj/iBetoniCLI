import { describe, test, expect, vi, beforeEach } from "vitest";
import { runKeikkaSearch } from "../../src/commands/keikka/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

// Two rows for keikka 1 (two betoni pours) + one for keikka 2 — must dedupe.
const RAW = [
  { keikkaId: 1, keikkaOtsikko: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z", asiakasNimi: "Lujabetoni", tyomaaNimi: "Kamppi", m3: 10, osoite: "Fredrikinkatu 51", contactPerson: "Kai K", contactPhone: "0401234567", keikkaBetoniId: 11 },
  { keikkaId: 1, keikkaOtsikko: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z", asiakasNimi: "Lujabetoni", tyomaaNimi: "Kamppi", m3: 2.5, osoite: "Fredrikinkatu 51", contactPerson: "Kai K", contactPhone: "0401234567", keikkaBetoniId: 12 },
  { keikkaId: 2, keikkaOtsikko: null, pumppuAika: "2026-06-08T08:00:00.000Z", asiakasNimi: "Rudus", tyomaaNimi: null, m3: 5, osoite: null, contactPerson: null, contactPhone: null, keikkaBetoniId: 13 },
];

describe("runKeikkaSearch", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(RAW);
  });

  test("calls /api/keikka/search with searchString, ownerAsiakasId, full-text flag", async () => {
    await runKeikkaSearch(mockClient, "kamppi", 1349);
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(path).toContain("/api/keikka/search?");
    expect(path).toContain("searchString=kamppi");
    expect(path).toContain("ownerAsiakasId=1349");
    expect(path).toContain("usingFullTextSearch=true");
  });

  test("dedupes rows by keikkaId and projects the envelope", async () => {
    const env = await runKeikkaSearch(mockClient, "kamppi", 1349);
    expect(env.count).toBe(2);
    expect(env.items[0]).toEqual({
      keikkaId: 1, title: "Kamppi valu", pumppuAika: "2026-06-09T07:00:00.000Z",
      customerName: "Lujabetoni", worksiteName: "Kamppi", address: "Fredrikinkatu 51",
      contactPerson: "Kai K", contactPhone: "0401234567",
    });
    expect(env.items[1].keikkaId).toBe(2);
    expect(env.items[1].title).toBeNull();
  });

  test("applies the client-side limit after dedupe", async () => {
    const env = await runKeikkaSearch(mockClient, "kamppi", 1349, 1);
    expect(env.count).toBe(1);
    expect(env.items[0].keikkaId).toBe(1);
  });

  test("tolerates an empty result", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const env = await runKeikkaSearch(mockClient, "nothing", 1349);
    expect(env).toEqual({ items: [], nextCursor: null, count: 0 });
  });
});
