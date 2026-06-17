import { describe, test, expect, vi } from "vitest";
import {
  runGlossaryLookup, runGlossaryList, runGlossarySet, runGlossaryMisses,
} from "../../src/commands/glossary/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mkClient = (over: Partial<ApiClient> = {}): ApiClient =>
  ({ get: vi.fn(), put: vi.fn(), delete: vi.fn(), post: vi.fn(), getCurrentToken: vi.fn(), ...over } as unknown as ApiClient);

describe("ib glossary", () => {
  test("lookup hits /api/cli/glossary/lookup/<term> (URL-encoded)", async () => {
    const get = vi.fn().mockResolvedValue({ term: "henkilö", synonyms: ["pumppari"], definition: "d", relatedCommands: [], relatedEntity: null });
    const r = await runGlossaryLookup(mkClient({ get }), "pumppari");
    expect(get).toHaveBeenCalledWith("/api/cli/glossary/lookup/pumppari");
    expect(r.term).toBe("henkilö");
  });

  test("list builds query string and wraps in ListEnvelope", async () => {
    const get = vi.fn().mockResolvedValue({ items: [{ term: "tila" }], count: 1 });
    const r = await runGlossaryList(mkClient({ get }), { search: "tila", stalest: 5 });
    expect(get).toHaveBeenCalledWith("/api/cli/glossary?search=tila&stalest=5");
    expect(r).toEqual({ items: [{ term: "tila" }], nextCursor: null, count: 1, truncated: true });
  });

  test("set PUTs body + write headers and splits comma lists", async () => {
    const put = vi.fn().mockResolvedValue({ term: "valumassa" });
    await runGlossarySet(mkClient({ put }), "valumassa",
      { definition: "x", synonyms: "massaa, valua", related: "ib keikka, ib stats", entity: "Keikka" },
      { reason: "groom" });
    expect(put).toHaveBeenCalledWith(
      "/api/cli/glossary/valumassa",
      { definition: "x", synonyms: ["massaa", "valua"], relatedCommands: ["ib keikka", "ib stats"], relatedEntity: "Keikka" },
      { headers: { "X-Action-Reason": "groom" } });
  });

  test("misses hits the dev endpoint with top", async () => {
    const get = vi.fn().mockResolvedValue({ items: [], count: 0 });
    await runGlossaryMisses(mkClient({ get }), 10);
    expect(get).toHaveBeenCalledWith("/api/cli/glossary/misses?top=10");
  });
});
