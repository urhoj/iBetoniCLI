import type { Command } from "commander";
import { TOPICS, GLOSSARY } from "../../reference/domain.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { CliError } from "../../api/errors.js";

/**
 * `ib help` (no arg) — list every concept-guide topic id+title. Offline, no
 * auth, no network (reads {@link TOPICS} only). Returns the universal list
 * envelope `{ items, nextCursor, count }` so the pretty renderer formats it.
 */
export function runHelpList(): {
  items: { id: string; title: string }[];
  nextCursor: null;
  count: number;
} {
  const items = TOPICS.map((t) => ({ id: t.id, title: t.title }));
  return { items, nextCursor: null, count: items.length };
}

/**
 * `ib help <id>` — return one concept guide `{ id, title, body }` from
 * {@link TOPICS}, falling back to {@link GLOSSARY} terms (e.g. `ib help tila`):
 * glossary entries are domain vocabulary, not concept guides, but `ib help
 * <term>` is the natural first guess so it resolves here too. Compound terms
 * ("asiakas / customer") match on any alias. Offline, no auth. Throws a
 * {@link CliError} mapped to exit 5 (not-found) when nothing matches; the
 * message lists the valid topic ids AND glossary terms.
 */
export function runHelpTopic(id: string): { id: string; title: string; body: string } {
  const t = TOPICS.find((x) => x.id === id);
  if (t) return { id: t.id, title: t.title, body: t.body };
  const needle = id.toLowerCase();
  const g = GLOSSARY.find((x) =>
    x.term.split("/").some((alias) => alias.trim().toLowerCase() === needle)
  );
  if (g) return { id, title: `${g.term} (glossary)`, body: g.definition };
  const ids = TOPICS.map((x) => x.id).join(", ");
  const terms = GLOSSARY.map((x) => x.term).join(", ");
  throw new CliError(
    `unknown topic: ${id}. Valid topics: ${ids}. Glossary terms (also resolvable here): ${terms}`,
    0,
    null,
    5
  );
}

/**
 * Register the offline `ib help [topic]` command (no `getClient` — needs no
 * auth). NOTE: Commander's built-in implicit `help` command is disabled in
 * `program.ts` via `program.helpCommand(false)` so this explicit command's
 * action runs; the `-h/--help` option is separate and unaffected.
 */
export function registerHelpCommands(program: Command): void {
  program
    .command("help [topic]")
    .description("Concept guides for AI users (offline). No arg = list topics.")
    .action((topic?: string) => {
      try {
        writeJson(topic ? runHelpTopic(topic) : runHelpList());
      } catch (e) {
        exitWithError(e);
      }
    });
}
