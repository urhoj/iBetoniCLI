import { describe, test, expect, vi } from "vitest";
import {
  runGlossaryLookup, runGlossaryList, runGlossarySet, runGlossaryMisses, runGlossaryLookupBatch,
  mergeSetInput, runGlossaryImport, runGlossaryDelete,
} from "../../src/commands/glossary/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

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

  test("set PUTs body + write headers and splits comma lists (omitted domain not sent)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "valumassa" });
    await runGlossarySet(mkClient({ put }), "valumassa",
      { definition: "x", synonyms: "massaa, valua", related: "ib keikka, ib stats", entity: "Keikka" },
      { reason: "groom" });
    // --domain was not passed → its key is OMITTED from the body (partial update),
    // so the backend preserves the current domain.
    expect(put).toHaveBeenCalledWith(
      "/api/cli/glossary/valumassa",
      { definition: "x", synonyms: ["massaa", "valua"], relatedCommands: ["ib keikka", "ib stats"], relatedEntity: "Keikka" },
      { headers: { "X-Action-Reason": "groom" } });
  });

  // ── Partial update (PATCH): only provided fields are sent ───────────────────

  test("set sends ONLY the fields provided (omitted flags absent from body → preserved)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "puomi" });
    await runGlossarySet(mkClient({ put }), "puomi", { synonyms: "boom,nollakone" }, { reason: "syn only" });
    const body = put.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toEqual({ synonyms: ["boom", "nollakone"] });
    // none of the other fields leak in as null/[] (which would overwrite them)
    expect("definition" in body).toBe(false);
    expect("relatedCommands" in body).toBe(false);
    expect("relatedEntity" in body).toBe(false);
    expect("domain" in body).toBe(false);
  });

  test("set with empty --synonyms sends [] (explicit clear, key present)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "puomi" });
    await runGlossarySet(mkClient({ put }), "puomi", { synonyms: "" }, { reason: "clear" });
    const body = put.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toEqual({ synonyms: [] });
  });

  test("set with empty --entity sends \"\" (explicit clear, not omitted)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "puomi" });
    await runGlossarySet(mkClient({ put }), "puomi", { entity: "" }, { reason: "clear" });
    const body = put.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toEqual({ relatedEntity: "" });
  });

  test("set with no content flags sends an empty body (touches only lastReviewed/runs server-side)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "puomi" });
    await runGlossarySet(mkClient({ put }), "puomi", {}, { reason: "touch" });
    expect(put.mock.calls[0]![1]).toEqual({});
  });

  test("misses hits the dev endpoint with top", async () => {
    const get = vi.fn().mockResolvedValue({ items: [], count: 0 });
    await runGlossaryMisses(mkClient({ get }), 10);
    expect(get).toHaveBeenCalledWith("/api/cli/glossary/misses?top=10");
  });

  // ── Change B: did-you-mean on lookup miss ──────────────────────────────────

  test("lookup miss with suggestions includes Did you mean in error message", async () => {
    const get = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/cli/glossary/lookup/")) {
        return Promise.reject(new CliError("not found", 404, null, 5));
      }
      // Search returns one suggestion
      return Promise.resolve({ items: [{ term: "pumppari" }], count: 1 });
    });
    const err = await runGlossaryLookup(mkClient({ get }), "pumppari").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(5);
    expect((err as CliError).message).toContain("Did you mean: pumppari");
  });

  test("lookup miss with no suggestions has no Did you mean in error message", async () => {
    const get = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/cli/glossary/lookup/")) {
        return Promise.reject(new CliError("not found", 404, null, 5));
      }
      return Promise.resolve({ items: [], count: 0 });
    });
    const err = await runGlossaryLookup(mkClient({ get }), "xyz").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(5);
    expect((err as CliError).message).not.toContain("Did you mean");
  });

  // ── Change C: --update-only flag on set ────────────────────────────────────

  test("set with updateOnly:true sends X-Update-Only header", async () => {
    const put = vi.fn().mockResolvedValue({ term: "pumppari" });
    await runGlossarySet(mkClient({ put }), "pumppari",
      { definition: "def", updateOnly: true },
      { reason: "groom" });
    expect(put).toHaveBeenCalledWith(
      "/api/cli/glossary/pumppari",
      expect.any(Object),
      { headers: expect.objectContaining({ "X-Update-Only": "1" }) });
  });

  test("set without updateOnly does not send X-Update-Only header", async () => {
    const put = vi.fn().mockResolvedValue({ term: "pumppari" });
    await runGlossarySet(mkClient({ put }), "pumppari",
      { definition: "def" },
      { reason: "groom" });
    const callArgs = put.mock.calls[0]![2] as { headers: Record<string, string> };
    expect(callArgs.headers).not.toHaveProperty("X-Update-Only");
  });

  test("runGlossaryLookup propagates a non-404 error unchanged", async () => {
    const err = new CliError("auth", 401, null, 2);
    const get = vi.fn().mockRejectedValue(err);
    await expect(runGlossaryLookup(mkClient({ get }), "pumppari")).rejects.toBe(err);
    // suggestion search must NOT be attempted for a non-404 error
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("glossary lookup batch", () => {
  test("returns per-term found flags; 404 → found:false (no throw)", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("loma")) return { term: "loma", synonyms: [], definition: "x", relatedCommands: [], relatedEntity: null };
      throw new CliError("not found", 404, null, 5);
    });
    const res = await runGlossaryLookupBatch(mkClient({ get }), ["loma", "nope"]);
    expect(res.count).toBe(2);
    expect(res.items.find((i) => i.term === "loma")).toMatchObject({ found: true });
    expect(res.items.find((i) => i.term === "nope")).toMatchObject({ found: false, entry: null });
  });

  test("non-404 error propagates (not swallowed as found:false)", async () => {
    const get = vi.fn(async () => { throw new CliError("auth", 401, null, 2); });
    await expect(runGlossaryLookupBatch(mkClient({ get }), ["x"])).rejects.toBeInstanceOf(CliError);
  });
});

describe("glossary set/import JSON input", () => {
  test("mergeSetInput: flags override JSON; arrays → csv", () => {
    const out = mergeSetInput(
      { definition: "d", synonyms: ["a", "b"], relatedCommands: ["ib x"], relatedEntity: "E" },
      { synonyms: "z" }
    );
    expect(out).toEqual({ definition: "d", synonyms: "z", related: "ib x", entity: "E" });
  });

  test("runGlossaryImport: PUTs each entry, reports ok/failed", async () => {
    const put = vi.fn(async (p: string) => ({ term: p.split("/").pop() }));
    const res = await runGlossaryImport(
      mkClient({ put }),
      [{ term: "loma", definition: "d1", synonyms: ["lomat"] }, { definition: "no term" }],
      { reason: "r" }
    );
    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toMatchObject({ definition: "d1", synonyms: ["lomat"] });
  });
});

describe("glossary list terms-only", () => {
  test("list --terms-only projects items to {term, synonyms} only", async () => {
    const get = vi.fn().mockResolvedValue({
      items: [{ term: "tila", synonyms: ["status"], definition: "d", relatedCommands: [], domain: "x", runs: 3 }],
      count: 1,
    });
    const r = await runGlossaryList(mkClient({ get }), { termsOnly: true });
    expect(r.items).toEqual([{ term: "tila", synonyms: ["status"] }]);
  });

  test("list without --terms-only returns items unchanged", async () => {
    const get = vi.fn().mockResolvedValue({
      items: [{ term: "tila", synonyms: ["status"], definition: "d" }],
      count: 1,
    });
    const r = await runGlossaryList(mkClient({ get }), {});
    expect(r.items[0]).toHaveProperty("definition", "d");
  });
});

describe("glossary domain filters", () => {
  test("list forwards --domain and --related as query params", async () => {
    const get = vi.fn().mockResolvedValue({ items: [], count: 0 });
    await runGlossaryList(mkClient({ get }), { domain: "vacation", related: "ib person day" });
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("domain=vacation");
    expect(url).toContain("related=ib+person+day");
  });

  test("set sends domain in the PUT body", async () => {
    const put = vi.fn().mockResolvedValue({ term: "loma" });
    await runGlossarySet(mkClient({ put }), "loma", { definition: "d", domain: "vacation" });
    expect(put.mock.calls[0][1]).toMatchObject({ domain: "vacation" });
  });

  test("mergeSetInput threads domain (flag overrides json)", () => {
    expect(mergeSetInput({ domain: "j" }, {}).domain).toBe("j");
    expect(mergeSetInput({ domain: "j" }, { domain: "f" }).domain).toBe("f");
  });
});

describe("glossary append flags", () => {
  test("set sends addSynonyms/removeSynonyms/appendDefinition body keys (synonyms split)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "puomi" });
    await runGlossarySet(mkClient({ put }), "puomi",
      { addSynonyms: "a, b", removeSynonyms: "c", appendDefinition: "More text." },
      { reason: "append" });
    const body = put.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toEqual({ addSynonyms: ["a", "b"], removeSynonyms: ["c"], appendDefinition: "More text." });
  });

  test("set rejects --definition + --append-definition (exit 4, no PUT)", async () => {
    const put = vi.fn();
    const err = await runGlossarySet(mkClient({ put }), "puomi",
      { definition: "x", appendDefinition: "y" }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect(put).not.toHaveBeenCalled();
  });

  test("set rejects --synonyms + --add-synonyms (exit 4, no PUT)", async () => {
    const put = vi.fn();
    const err = await runGlossarySet(mkClient({ put }), "puomi",
      { synonyms: "a", addSynonyms: "b" }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect(put).not.toHaveBeenCalled();
  });

  test("set sends aiConfidence + needsHumanReview when provided", async () => {
    const put = vi.fn().mockResolvedValue({ term: "valumassa" });
    await runGlossarySet(mkClient({ put }), "valumassa",
      { definition: "x", aiConfidence: 75, needsHumanReview: true },
      { reason: "groom" });
    const body = put.mock.calls[0][1];
    expect(body.aiConfidence).toBe(75);
    expect(body.needsHumanReview).toBe(true);
  });

  test("set omits aiConfidence when not provided", async () => {
    const put = vi.fn().mockResolvedValue({});
    await runGlossarySet(mkClient({ put }), "valumassa", { definition: "x" }, { reason: "groom" });
    const body = put.mock.calls[0][1];
    expect("aiConfidence" in body).toBe(false);
    expect("needsHumanReview" in body).toBe(false);
  });

  test("list passes needsReview + maxConfidence", async () => {
    const get = vi.fn().mockResolvedValue({ items: [], count: 0 });
    await runGlossaryList(mkClient({ get }), { needsReview: true, maxConfidence: 90 });
    expect(get).toHaveBeenCalledWith("/api/cli/glossary?needsReview=1&maxConfidence=90");
  });
});

// ── delete: --dry-run must NEVER issue the DELETE (fb#76 data-loss fix) ────────
describe("glossary delete", () => {
  test("real delete issues DELETE with write-safety headers", async () => {
    const del = vi.fn().mockResolvedValue({ deleted: 1 });
    const get = vi.fn();
    await runGlossaryDelete(mkClient({ delete: del, get }), "obsolete term", { reason: "cleanup" });
    expect(del).toHaveBeenCalledWith(
      "/api/cli/glossary/obsolete%20term",
      { headers: { "X-Action-Reason": "cleanup" } }
    );
    // a real delete never reaches for the client-side preview
    expect(get).not.toHaveBeenCalled();
  });

  test("--dry-run resolves CLIENT-SIDE: previews via ?search=, never issues DELETE", async () => {
    const entry = { term: "pumi.fi", synonyms: ["kutil"], definition: "legacy", relatedCommands: [], relatedEntity: null };
    const get = vi.fn().mockResolvedValue({ items: [{ term: "other" }, entry], count: 2 });
    const del = vi.fn();
    const res = await runGlossaryDelete(mkClient({ delete: del, get }), "pumi.fi", { dryRun: true, reason: "preview" });
    expect(del).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith("/api/cli/glossary?search=pumi.fi");
    expect(res).toEqual({ dryRun: true, term: "pumi.fi", wouldDelete: entry });
  });

  test("--dry-run exact-matches the normalized term (case/space-insensitive)", async () => {
    const entry = { term: "pumi.fi", synonyms: [], definition: "d", relatedCommands: [], relatedEntity: null };
    const get = vi.fn().mockResolvedValue({ items: [entry], count: 1 });
    const res = await runGlossaryDelete(mkClient({ delete: vi.fn(), get }), "  PUMI.FI  ", { dryRun: true });
    expect(res).toMatchObject({ dryRun: true, wouldDelete: entry });
  });

  test("--dry-run returns wouldDelete:null when no exact match (no substring false-positive)", async () => {
    const get = vi.fn().mockResolvedValue({ items: [{ term: "pumi.fi.legacy" }], count: 1 });
    const res = await runGlossaryDelete(mkClient({ delete: vi.fn(), get }), "pumi.fi", { dryRun: true });
    expect(res).toEqual({ dryRun: true, term: "pumi.fi", wouldDelete: null });
  });

  test("--dry-run swallows a preview fetch error and still returns a safe envelope", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("boom", 500, null, 6));
    const del = vi.fn();
    const res = await runGlossaryDelete(mkClient({ delete: del, get }), "pumi.fi", { dryRun: true });
    expect(del).not.toHaveBeenCalled();
    expect(res).toEqual({ dryRun: true, term: "pumi.fi", wouldDelete: null });
  });
});
