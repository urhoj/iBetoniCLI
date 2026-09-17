import { describe, test, expect, vi } from "vitest";
import { Command } from "commander";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGlossaryLookup, runGlossaryList, runGlossarySet, runGlossaryMisses, runGlossaryLookupBatch,
  mergeSetInput, runGlossaryImport, runGlossaryDelete, runGlossaryDismiss, registerGlossaryCommands,
  glossarySetJsonKeys, canonicalGlossarySetJson,
} from "../../src/commands/glossary/index.js";
import { normalizeFromJson } from "../../src/commands/_shared/fromJson.js";
import { mockApiClient, type MockApiClient, type MockApiClientOverrides } from "../helpers/mockClient.js";
import { CliError } from "../../src/api/errors.js";

const mkClient = (over: MockApiClientOverrides = {}): MockApiClient => mockApiClient(over);

/** The `set` command's derived --from-json key map — what `import` validates entries against. */
const KEYS = (() => {
  const program = new Command();
  registerGlossaryCommands(program, async () => mkClient());
  const glossary = program.commands.find((c) => c.name() === "glossary")!;
  return glossarySetJsonKeys(glossary.commands.find((c) => c.name() === "set")!);
})();

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
    // `_body` declared so `put.mock.calls[0][1]` is in bounds — a one-param
    // vi.fn() types calls as a 1-tuple and every body assertion below is then
    // an out-of-range index.
    const put = vi.fn(async (p: string, _body?: unknown) => ({ term: p.split("/").pop() }));
    const res = await runGlossaryImport(
      mkClient({ put }),
      [{ term: "loma", definition: "d1", synonyms: ["lomat"] }, { definition: "no term" }],
      { reason: "r" },
      KEYS
    );
    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toMatchObject({ definition: "d1", synonyms: ["lomat"] });
  });

  test("runGlossaryImport: keeps input order and caps concurrency when PUTs finish out of order", async () => {
    // Entries resolve in REVERSE order (entry 0 slowest), and one rejects — the
    // results array must still mirror the input order, and the batch must not abort.
    const entries = Array.from({ length: 12 }, (_, i) => ({ term: `t${i}`, definition: `d${i}` }));
    let inFlight = 0;
    let peak = 0;
    const put = vi.fn(async (p: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, (entries.length - Number(p.split("/").pop()!.slice(1))) * 2));
      inFlight--;
      if (p.endsWith("/t3")) throw new Error("boom");
      return { term: p.split("/").pop() };
    });
    const res = await runGlossaryImport(mkClient({ put }), entries, { reason: "r" }, KEYS);
    expect(res.results.map((r) => r.term)).toEqual(entries.map((e) => e.term));
    expect(res.results[3]).toMatchObject({ term: "t3", ok: false });
    expect(res.ok).toBe(11);
    expect(res.failed).toBe(1);
    expect(put).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(5); // bounded pool, not unbounded Promise.all
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

  // fb#1709: --limit is a client-side cut, flagged by truncated + hint.
  test("list --limit cuts client-side and flags truncated", async () => {
    const get = vi.fn().mockResolvedValue({ items: [{ term: "a" }, { term: "b" }, { term: "c" }], count: 3 });
    const r = await runGlossaryList(mkClient({ get }), { needsReview: true, limit: 2 });
    expect(get.mock.calls[0][0]).not.toContain("limit");
    expect(r.items).toEqual([{ term: "a" }, { term: "b" }]);
    expect(r.count).toBe(2); // fb#1756: count follows the cut, never the server total
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/raise --limit/);
  });

  test("list --limit above the row count is a no-op (not truncated)", async () => {
    const get = vi.fn().mockResolvedValue({ items: [{ term: "a" }, { term: "b" }], count: 2 });
    const r = await runGlossaryList(mkClient({ get }), { limit: 5 });
    expect(r.items).toHaveLength(2);
    expect(r.truncated).toBe(false);
    expect(r).not.toHaveProperty("hint");
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

// ─── fb#298: --from-json must carry the assessment fields ────────────────────
// The backend DIRECT-ASSIGNS aiConfidence/needsHumanReview (it does not COALESCE
// them), so a dropped JSON key does not merely fail to write — it wipes the
// stored score. These guard the whole path, not just the merge helper: the
// original defect was at the ACTION call site, which passed opts.* instead of
// the merged values, so a mergeSetInput-only test would have stayed green.
describe("glossary assessment fields from --from-json (fb#298)", () => {
  const withJsonFile = async (payload: unknown, fn: (path: string) => Promise<void>) => {
    const p = join(tmpdir(), `ib-glossary-fromjson-${process.pid}.json`);
    writeFileSync(p, JSON.stringify(payload), "utf8");
    try { await fn(p); } finally { unlinkSync(p); }
  };

  test("mergeSetInput carries both fields from JSON; an explicit flag still wins", () => {
    expect(mergeSetInput({ aiConfidence: 90, needsHumanReview: true }, {}))
      .toMatchObject({ aiConfidence: 90, needsHumanReview: true });
    expect(mergeSetInput({ aiConfidence: 90 }, { aiConfidence: 40 }).aiConfidence).toBe(40);
    // Absent from both → undefined (omitted from the body; the backend resets).
    expect(mergeSetInput({}, {}).aiConfidence).toBeUndefined();
  });

  test("set --from-json PUTs the JSON aiConfidence (before the fix the score was silently nulled)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "x" });
    await withJsonFile({ definition: "d", aiConfidence: 90 }, async (p) => {
      const program = new Command();
      registerGlossaryCommands(program, async () => mkClient({ put }));
      await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
    });
    expect(put.mock.calls[0][1]).toMatchObject({ definition: "d", aiConfidence: 90 });
  });

  test("an explicit --ai-confidence overrides the JSON key", async () => {
    const put = vi.fn().mockResolvedValue({ term: "x" });
    await withJsonFile({ definition: "d", aiConfidence: 90 }, async (p) => {
      const program = new Command();
      registerGlossaryCommands(program, async () => mkClient({ put }));
      await program.parseAsync(["glossary", "set", "x", "--from-json", p, "--ai-confidence", "40"], { from: "user" });
    });
    expect(put.mock.calls[0][1]).toMatchObject({ aiConfidence: 40 });
  });

  test("an out-of-range aiConfidence in the JSON exits 4 client-side (no PUT)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "x" });
    await withJsonFile({ definition: "d", aiConfidence: 150 }, async (p) => {
      const program = new Command();
      registerGlossaryCommands(program, async () => mkClient({ put }));
      // The guard's CliError is caught by the action's `guarded` tail, so the
      // failure surfaces as the exit-4 envelope rather than a parse rejection.
      const prevExit = process.exitCode;
      process.exitCode = undefined;
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
        expect(process.exitCode).toBe(4);
      } finally {
        stderr.mockRestore();
        process.exitCode = prevExit;
      }
    });
    expect(put).not.toHaveBeenCalled();
  });

  test("an unknown key in --from-json exits 4 (no PUT), naming the accepted keys (fb#1533)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "x" });
    await withJsonFile({ definition: "d", bogusKeyThatDoesNotExist: "x" }, async (p) => {
      const program = new Command();
      registerGlossaryCommands(program, async () => mkClient({ put }));
      const prevExit = process.exitCode;
      process.exitCode = undefined;
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
        expect(process.exitCode).toBe(4);
        const written = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(written).toContain("unknown key bogusKeyThatDoesNotExist");
        expect(written).toContain("accepted:");
        expect(written).toContain("definition");
      } finally {
        stderr.mockRestore();
        process.exitCode = prevExit;
      }
    });
    expect(put).not.toHaveBeenCalled();
  });

  // fb#1712: the merge flags have JSON twins, so a grooming batch driven
  // through --from-json (the argv-safe path for Finnish prose) can append a
  // clause without resending the whole definition. Same exclusion rules as
  // the flags. fb#1607: the accepted-key set is now DERIVED from the command's
  // own options via payloadKeyMap — the flag spelling is therefore accepted too.
  describe("merge keys in --from-json (fb#1712) and the derived key set (fb#1607)", () => {
    test("mergeSetInput carries appendDefinition/addSynonyms/removeSynonyms (arrays → csv); flags win", () => {
      expect(mergeSetInput({ appendDefinition: " Lisäys.", addSynonyms: ["a", "b"], removeSynonyms: "c" }, {}))
        .toMatchObject({ appendDefinition: " Lisäys.", addSynonyms: "a,b", removeSynonyms: "c" });
      expect(mergeSetInput({ addSynonyms: ["a"] }, { addSynonyms: "z" }).addSynonyms).toBe("z");
    });

    test("set --from-json PUTs appendDefinition + addSynonyms as lists, no definition/synonyms key", async () => {
      const put = vi.fn().mockResolvedValue({ term: "x" });
      await withJsonFile({ appendDefinition: " Lisäys.", addSynonyms: ["eräpvm", "due"] }, async (p) => {
        const program = new Command();
        registerGlossaryCommands(program, async () => mkClient({ put }));
        await program.parseAsync(["glossary", "set", "x", "--from-json", p, "--update-only"], { from: "user" });
      });
      expect(put.mock.calls[0][1]).toEqual({ appendDefinition: " Lisäys.", addSynonyms: ["eräpvm", "due"] });
    });

    test("the flag spelling (append-definition) is accepted as a JSON key too", async () => {
      const put = vi.fn().mockResolvedValue({ term: "x" });
      await withJsonFile({ "append-definition": " Lisäys." }, async (p) => {
        const program = new Command();
        registerGlossaryCommands(program, async () => mkClient({ put }));
        await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
      });
      expect(put.mock.calls[0][1]).toEqual({ appendDefinition: " Lisäys." });
    });

    test("definition + appendDefinition in one JSON object exits 4 (same rule as the flags), no PUT", async () => {
      const put = vi.fn().mockResolvedValue({ term: "x" });
      await withJsonFile({ definition: "d", appendDefinition: " e" }, async (p) => {
        const program = new Command();
        registerGlossaryCommands(program, async () => mkClient({ put }));
        const prevExit = process.exitCode;
        process.exitCode = undefined;
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
          expect(process.exitCode).toBe(4);
          expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("mutually exclusive");
        } finally {
          stderr.mockRestore();
          process.exitCode = prevExit;
        }
      });
      expect(put).not.toHaveBeenCalled();
    });

    test("the unknown-key message lists the merge keys among the accepted ones", async () => {
      const put = vi.fn().mockResolvedValue({ term: "x" });
      await withJsonFile({ nope: 1 }, async (p) => {
        const program = new Command();
        registerGlossaryCommands(program, async () => mkClient({ put }));
        const prevExit = process.exitCode;
        process.exitCode = undefined;
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
          const written = stderr.mock.calls.map((c) => String(c[0])).join("");
          for (const k of ["appendDefinition", "addSynonyms", "removeSynonyms", "relatedCommands", "relatedEntity", "needsHumanReview"]) {
            expect(written).toContain(k);
          }
          // Non-payload flags never leak into the accepted set.
          for (const k of ["fromJson", "updateOnly", "dryRun", "reason"]) expect(written).not.toContain(k);
        } finally {
          stderr.mockRestore();
          process.exitCode = prevExit;
        }
      });
    });

    test("import entries carry the merge keys too", async () => {
      const put = vi.fn().mockResolvedValue({ term: "x" });
      await runGlossaryImport(mkClient({ put }), [{ term: "x", addSynonyms: ["a"] }], {}, KEYS);
      expect(put.mock.calls[0][1]).toEqual({ addSynonyms: ["a"] });
    });
  });

  // The reporter's own repro (fb#1533): the required `term` positional put
  // inside the JSON body instead — previously silently dropped, then failed
  // downstream with a confusing "missing required argument term". It must now
  // be rejected up front, by name, same as any other unknown key.
  // fb#1776 relaxed this from "any `term` key is unknown" to "a `term` naming a
  // DIFFERENT entry is rejected by name" — the lookup row carries the key.
  test("`term` inside the JSON that names another entry is rejected by name, not silently dropped", async () => {
    const put = vi.fn().mockResolvedValue({ term: "x" });
    await withJsonFile({ term: "pumppumatka", definition: "d" }, async (p) => {
      const program = new Command();
      registerGlossaryCommands(program, async () => mkClient({ put }));
      const prevExit = process.exitCode;
      process.exitCode = undefined;
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
        expect(process.exitCode).toBe(4);
        expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain('is \\"pumppumatka\\" but the positional is \\"x\\"');
      } finally {
        stderr.mockRestore();
        process.exitCode = prevExit;
      }
    });
    expect(put).not.toHaveBeenCalled();
  });

  test("import forwards a per-entry aiConfidence — a bulk groom no longer wipes every score", async () => {
    // `_body` declared so `put.mock.calls[0][1]` is in bounds — a one-param
    // vi.fn() types calls as a 1-tuple and every body assertion below is then
    // an out-of-range index.
    const put = vi.fn(async (p: string, _body?: unknown) => ({ term: p.split("/").pop() }));
    await runGlossaryImport(
      mkClient({ put }),
      [{ term: "loma", definition: "d", aiConfidence: 85, needsHumanReview: true }],
      { reason: "groom" },
      KEYS
    );
    expect(put.mock.calls[0][1]).toMatchObject({ aiConfidence: 85, needsHumanReview: true });
  });
});

// fb#1606: the fb#1533 unknown-key guard checked NAMES only. A known key with
// a wrong-typed value (`{"synonyms": 123}`) passed it, then arrToCsv read the
// number as "absent" — the silent keep-current-value no-op the guard was built
// to eliminate, one layer down. The shared normalizeFromJson pass now owns the
// types, for `set --from-json` and per `import` entry alike.
describe("glossary --from-json value types (fb#1606)", () => {
  const withJsonFile = async (payload: unknown, fn: (path: string) => Promise<void>) => {
    const p = join(tmpdir(), `ib-glossary-types-${process.pid}.json`);
    writeFileSync(p, JSON.stringify(payload), "utf8");
    try { await fn(p); } finally { unlinkSync(p); }
  };
  const runSet = async (payload: unknown, put = vi.fn().mockResolvedValue({ term: "x" })) => {
    let written = "";
    let exit: number | undefined;
    await withJsonFile(payload, async (p) => {
      const program = new Command();
      registerGlossaryCommands(program, async () => mkClient({ put }));
      const prevExit = process.exitCode;
      process.exitCode = undefined;
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await program.parseAsync(["glossary", "set", "x", "--from-json", p], { from: "user" });
        exit = process.exitCode as number | undefined;
        written = stderr.mock.calls.map((c) => String(c[0])).join("");
      } finally {
        stderr.mockRestore();
        process.exitCode = prevExit;
      }
    });
    return { put, exit, written };
  };

  test("canonicalGlossarySetJson: a wrong-typed known key is rejected BY NAME (before: a silent keep-current no-op)", () => {
    expect(() => canonicalGlossarySetJson({ synonyms: 123 }, KEYS)).toThrow(/synonyms/);
    // An object WITHOUT `command` is still wrong-typed; the lookup shape `{command,…}` is accepted below (fb#1776).
    expect(() => canonicalGlossarySetJson({ relatedCommands: [{ path: "ib keikka" }] }, KEYS)).toThrow(/relatedCommands/);
    expect(() => canonicalGlossarySetJson({ definition: ["a"] }, KEYS)).toThrow(/definition/);
    expect(() => canonicalGlossarySetJson({ needsHumanReview: "yes" }, KEYS)).toThrow(/needsHumanReview.*true or false/);
    expect(() => canonicalGlossarySetJson({ aiConfidence: "high" }, KEYS)).toThrow(/aiConfidence/);
  });

  test("valid shapes still pass: arrays → csv, flag spelling re-keyed, numeric string coerced", () => {
    expect(canonicalGlossarySetJson(
      { synonyms: ["a", "b"], "append-definition": "x", relatedEntity: "keikka", aiConfidence: "80", needsHumanReview: false }, KEYS
    )).toEqual({ synonyms: "a,b", appendDefinition: "x", entity: "keikka", aiConfidence: 80, needsHumanReview: false });
  });

  // fb#1776: the lookup → edit → set loop. This is a real `ib glossary lookup`
  // row, definition edited, fed back unchanged otherwise.
  test("a `glossary lookup` row round-trips through set --from-json unchanged (fb#1776)", () => {
    const row = {
      term: "loma",
      synonyms: ["lomat", "vacation"],
      definition: "Edited definition.",
      relatedCommands: [{ command: "ib person vacation list", summary: null }, { command: "ib person vacation add", summary: "…" }],
      relatedEntity: "person",
      domain: "vacation",
      lastReviewed: "2026-09-01T00:00:00.000Z",
      runs: 12,
      aiConfidence: 90,
      needsHumanReview: false,
    };
    expect(canonicalGlossarySetJson(row, KEYS, "loma")).toEqual({
      synonyms: "lomat,vacation",
      definition: "Edited definition.",
      related: "ib person vacation list,ib person vacation add",
      entity: "person",
      domain: "vacation",
      aiConfidence: 90,
      needsHumanReview: false,
    });
    // Case/whitespace on `term` is not a mismatch; a DIFFERENT term is, by name.
    expect(() => canonicalGlossarySetJson({ term: " Loma " }, KEYS, "loma")).not.toThrow();
    expect(() => canonicalGlossarySetJson({ term: "puomi" }, KEYS, "loma")).toThrow(/"term" is "puomi" but the positional is "loma"/);
    // `import` strips `term` itself and calls without a positional — the key is simply dropped.
    expect(canonicalGlossarySetJson({ term: "anything", runs: 3 }, KEYS)).toEqual({});
    // A genuinely unknown key still fails, now pointing at the help.
    expect(() => canonicalGlossarySetJson({ definitoin: "x" }, KEYS, "loma")).toThrow(/unknown key definitoin.*ib glossary set --help/);
  });

  test("a JSON null on the assessment pair is still the documented CLEAR (fb#1707), not an omission", () => {
    expect(canonicalGlossarySetJson({ aiConfidence: null, needsHumanReview: null }, KEYS))
      .toEqual({ aiConfidence: null, needsHumanReview: null });
    // …while null elsewhere stays "omitted → keep current"
    expect(canonicalGlossarySetJson({ synonyms: null }, KEYS)).toEqual({});
  });

  test("set --from-json {synonyms: 123} exits 4 naming the key, no PUT", async () => {
    const { put, exit, written } = await runSet({ synonyms: 123 });
    expect(exit).toBe(4);
    expect(written).toContain("synonyms");
    expect(put).not.toHaveBeenCalled();
  });

  test("set --from-json with a valid array still PUTs it as a list", async () => {
    const { put } = await runSet({ synonyms: ["a", "b"] });
    expect(put.mock.calls[0][1]).toEqual({ synonyms: ["a", "b"] });
  });

  test("import: a wrong-typed entry fails by name and the batch continues", async () => {
    const put = vi.fn(async (p: string, _body?: unknown) => ({ term: p.split("/").pop() }));
    const res = await runGlossaryImport(
      mkClient({ put }),
      [{ term: "bad", synonyms: 123 }, { term: "stray", definition: "d", definitoin: "typo" }, { term: "good", synonyms: ["a"] }],
      {},
      KEYS
    );
    expect(res.results[0]).toMatchObject({ term: "bad", ok: false, error: expect.stringContaining("synonyms") });
    expect(res.results[1]).toMatchObject({ term: "stray", ok: false, error: expect.stringContaining("unknown key definitoin") });
    expect(res.results[2]).toEqual({ term: "good", ok: true });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toEqual({ synonyms: ["a"] });
  });

  test("normalizeFromJson booleanFields: true/false pass, anything else is rejected by name", () => {
    const keys = new Map([["flag", "flag"]]);
    const cfg = { booleanFields: new Set(["flag"]) };
    expect(normalizeFromJson({ flag: true }, keys, cfg)).toEqual({ flag: true });
    expect(normalizeFromJson({ flag: false }, keys, cfg)).toEqual({ flag: false });
    expect(() => normalizeFromJson({ flag: "true" }, keys, cfg)).toThrow(/"flag" must be true or false \(got string\)/);
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

  test("set sends needsHumanReview: false when explicitly cleared (fb#952)", async () => {
    const put = vi.fn().mockResolvedValue({ term: "valumassa" });
    await runGlossarySet(mkClient({ put }), "valumassa",
      { definition: "x", needsHumanReview: false },
      { reason: "groom" });
    const body = put.mock.calls[0][1];
    expect(body.needsHumanReview).toBe(false);
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

// ── dismiss: junk misses leave the queue without being defined ────────────────
describe("glossary dismiss", () => {
  test("issues DELETE to the misses endpoint with write-safety headers", async () => {
    const del = vi.fn().mockResolvedValue({ term: "xa4", dismissed: 1 });
    await runGlossaryDismiss(mkClient({ delete: del }), "xa4", { reason: "junk" });
    expect(del).toHaveBeenCalledWith(
      "/api/cli/glossary/misses/xa4",
      { headers: { "X-Action-Reason": "junk" } }
    );
  });

  test("--dry-run maps to the X-Dry-Run header (server guard ships with the route; an older backend 404s the path, so no silent-persist window)", async () => {
    const del = vi.fn().mockResolvedValue({ dryRun: true, term: "xa4", wouldDismiss: true });
    await runGlossaryDismiss(mkClient({ delete: del }), "xa4", { dryRun: true });
    expect(del).toHaveBeenCalledWith(
      "/api/cli/glossary/misses/xa4",
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("URL-encodes multi-word terms", async () => {
    const del = vi.fn().mockResolvedValue({ term: "kualle urho tilaukset", dismissed: 1 });
    await runGlossaryDismiss(mkClient({ delete: del }), "kualle urho tilaukset", {});
    expect(del.mock.calls[0]![0]).toBe("/api/cli/glossary/misses/kualle%20urho%20tilaukset");
  });

  test("rejects an empty/whitespace term (exit 4, no DELETE)", async () => {
    const del = vi.fn();
    const err = await runGlossaryDismiss(mkClient({ delete: del }), "  ", {}).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect(del).not.toHaveBeenCalled();
  });
});
