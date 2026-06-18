/**
 * `ib glossary` — the DB-backed domain glossary (synonym-aware vocabulary).
 * lookup/list are open; set/delete/misses are developer-only. Backend:
 * /api/cli/glossary/*. The vocabulary is the single source of truth in the DB
 * (not bundled in betonicli) and is groomed via `ib glossary set`.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../api/writeFlags.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { CliError } from "../../api/errors.js";

interface GlossaryEntry {
  term: string;
  synonyms: string[];
  definition: string | null;
  relatedCommands: Array<{ command: string; summary: string | null }>;
  relatedEntity: string | null;
}

const splitList = (s?: string): string[] =>
  (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export async function runGlossaryLookup(client: ApiClient, term: string): Promise<GlossaryEntry> {
  try {
    return await client.get(`/api/cli/glossary/lookup/${encodeURIComponent(term)}`);
  } catch (e) {
    if (e instanceof CliError && e.exitCode === 5) {
      // Enrich the miss with did-you-mean suggestions from the search endpoint.
      let hint = "";
      try {
        const prefix = term.length > 5 ? term.slice(0, 5) : term;
        const [full, partial] = await Promise.all([
          client.get(`/api/cli/glossary?search=${encodeURIComponent(term)}`).catch(() => ({ items: [] })),
          term.length > 5
            ? client.get(`/api/cli/glossary?search=${encodeURIComponent(prefix)}`).catch(() => ({ items: [] }))
            : Promise.resolve({ items: [] }),
        ]);
        const seen = new Set<string>();
        const suggestions: string[] = [];
        for (const item of [
          ...(full as { items: Array<{ term: string }> }).items,
          ...(partial as { items: Array<{ term: string }> }).items,
        ]) {
          if (!seen.has(item.term)) { seen.add(item.term); suggestions.push(item.term); }
        }
        if (suggestions.length > 0) {
          hint = ` Did you mean: ${suggestions.slice(0, 5).join(", ")}?`;
        }
      } catch { /* ignore suggestion errors */ }
      throw new CliError(
        `no glossary entry for '${term}'.${hint} (it has been recorded for definition)`,
        e.statusCode,
        e.body,
        5
      );
    }
    throw e;
  }
}

export async function runGlossaryList(
  client: ApiClient,
  opts: { search?: string; stalest?: number }
): Promise<ListEnvelope<unknown>> {
  const q = new URLSearchParams();
  if (opts.search) q.set("search", opts.search);
  if (opts.stalest) q.set("stalest", String(opts.stalest));
  const qs = q.toString();
  const res = await client.get(`/api/cli/glossary${qs ? `?${qs}` : ""}`);
  return { items: (res as { items: unknown[] }).items, nextCursor: null, count: (res as { count: number }).count, truncated: opts.stalest != null };
}

export async function runGlossarySet(
  client: ApiClient,
  term: string,
  opts: { definition?: string; synonyms?: string; related?: string; entity?: string; updateOnly?: boolean },
  flags: WriteFlags = {}
): Promise<unknown> {
  const headers = { ...writeFlagsToHeaders(flags), ...(opts.updateOnly ? { "X-Update-Only": "1" } : {}) };
  return client.put(
    `/api/cli/glossary/${encodeURIComponent(term)}`,
    {
      definition: opts.definition,
      synonyms: splitList(opts.synonyms),
      relatedCommands: splitList(opts.related),
      relatedEntity: opts.entity ?? null,
    },
    { headers }
  );
}

export async function runGlossaryMisses(client: ApiClient, top?: number): Promise<ListEnvelope<unknown>> {
  const res = await client.get(`/api/cli/glossary/misses${top ? `?top=${top}` : ""}`);
  return { items: (res as { items: unknown[] }).items, nextCursor: null, count: (res as { count: number }).count, truncated: top != null };
}

export async function runGlossaryDelete(client: ApiClient, term: string, flags: WriteFlags = {}): Promise<unknown> {
  return client.delete(`/api/cli/glossary/${encodeURIComponent(term)}`, { headers: writeFlagsToHeaders(flags) });
}

export function registerGlossaryCommands(program: Command, getClient: () => Promise<ApiClient>): void {
  const glossary = program.command("glossary").description("Domain glossary: resolve a Finnish/colloquial term to its meaning + commands (DB-backed)");

  // Change A: mark lookup as the default subcommand so `ib glossary <term>`
  // routes here without spelling out "lookup". The term is optional so bare
  // `ib glossary` (no arg) shows a friendly usage message instead of erroring.
  glossary
    .command("lookup [term]", { isDefault: true })
    .description("Resolve a term or synonym to its definition + related commands (exit 5 if undefined; the miss is recorded)")
    .action(async (term: string | undefined) => {
      if (!term) {
        // Bare `ib glossary` with no subcommand and no term — show group help.
        glossary.outputHelp();
        return;
      }
      try { writeJson(await runGlossaryLookup(await getClient(), term)); } catch (e) { exitWithError(e); }
    });

  glossary
    .command("list")
    .description("List glossary entries; --search filters, --stalest orders least-recently-reviewed first")
    .option("--search <s>", "Filter by term/definition/synonym substring")
    .option("--stalest <n>", "Return up to N entries, stalest first", (v: string) => Number(v))
    .action(async (opts: { search?: string; stalest?: number }) => {
      try { writeJson(await runGlossaryList(await getClient(), opts)); } catch (e) { exitWithError(e); }
    });

  glossary
    .command("misses")
    .description("Open lookup misses ranked by frequency — the groomer's queue (developer only)")
    .option("--top <n>", "Return up to N", (v: string) => Number(v))
    .action(async (opts: { top?: number }) => {
      try { writeJson(await runGlossaryMisses(await getClient(), opts.top)); } catch (e) { exitWithError(e); }
    });

  const set = glossary
    .command("set")
    .description("Create/update a glossary entry (developer only)")
    .argument("<term>", "Canonical term")
    .option("--definition <d>", "One-paragraph definition")
    .option("--synonyms <list>", "Comma-separated aliases incl. inflections")
    .option("--related <list>", 'Comma-separated command paths, e.g. "ib person,ib driver board"')
    .option("--entity <e>", "Related DB entity, e.g. Person / personId")
    .option("--update-only", "Only update an existing term; do not create a new one (404 if absent)");
  addWriteFlagsToCommand(set).action(
    async (term: string, opts: { definition?: string; synonyms?: string; related?: string; entity?: string; updateOnly?: boolean; dryRun?: boolean; idempotencyKey?: string; reason?: string }) => {
      try {
        writeJson(await runGlossarySet(await getClient(), term,
          { definition: opts.definition, synonyms: opts.synonyms, related: opts.related, entity: opts.entity, updateOnly: opts.updateOnly },
          { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
      } catch (e) { exitWithError(e); }
    });

  const del = glossary
    .command("delete")
    .description("Delete a glossary entry (developer only)")
    .argument("<term>", "Canonical term");
  addWriteFlagsToCommand(del).action(
    async (term: string, opts: { dryRun?: boolean; idempotencyKey?: string; reason?: string }) => {
      try {
        writeJson(await runGlossaryDelete(await getClient(), term,
          { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
      } catch (e) { exitWithError(e); }
    });
}
