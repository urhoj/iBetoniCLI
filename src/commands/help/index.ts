import type { Command } from "commander";
import { TOPICS } from "../../reference/domain.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { CliError } from "../../api/errors.js";

/** `ib help` lists topic ids; `ib help <id>` prints one. Offline, no auth. */
export function runHelpList(): {
  items: { id: string; title: string }[];
  nextCursor: null;
  count: number;
} {
  const items = TOPICS.map((t) => ({ id: t.id, title: t.title }));
  return { items, nextCursor: null, count: items.length };
}

export function runHelpTopic(id: string): { id: string; title: string; body: string } {
  const t = TOPICS.find((x) => x.id === id);
  if (!t) {
    const ids = TOPICS.map((x) => x.id).join(", ");
    throw new CliError(`unknown topic: ${id}. Valid: ${ids}`, 404, null, 5);
  }
  return { id: t.id, title: t.title, body: t.body };
}

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
