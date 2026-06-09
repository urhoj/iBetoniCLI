import type { Command } from "commander";
import { TOPICS } from "../../reference/domain.js";
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
 * {@link TOPICS}. Offline, no auth. Throws a {@link CliError} mapped to exit 5
 * (not-found) when `id` is not a known topic; the message lists the valid ids.
 */
export function runHelpTopic(id: string): { id: string; title: string; body: string } {
  const t = TOPICS.find((x) => x.id === id);
  if (!t) {
    const ids = TOPICS.map((x) => x.id).join(", ");
    throw new CliError(`unknown topic: ${id}. Valid: ${ids}`, 0, null, 5);
  }
  return { id: t.id, title: t.title, body: t.body };
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
