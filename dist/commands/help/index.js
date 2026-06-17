import { TOPICS } from "../../reference/domain.js";
import { runGlossaryLookup } from "../glossary/index.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { CliError } from "../../api/errors.js";
/**
 * `ib help` (no arg) — list every concept-guide topic id+title. Offline, no
 * auth, no network (reads {@link TOPICS} only). Returns the universal list
 * envelope `{ items, nextCursor, count }` so the pretty renderer formats it.
 */
export function runHelpList() {
    const items = TOPICS.map((t) => ({ id: t.id, title: t.title }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * `ib help <id>` — return one concept guide `{ id, title, body }` from
 * {@link TOPICS}. Known topics are resolved offline. Unknown ids fall back to
 * an async DB glossary lookup (`ib glossary lookup`), so `ib help <term>` works
 * for vocabulary too. Throws a {@link CliError} mapped to exit 5 (not-found)
 * when nothing matches.
 */
export async function runHelpTopic(id, getClient) {
    const t = TOPICS.find((x) => x.id === id);
    if (t)
        return { id: t.id, title: t.title, body: t.body };
    // Fallback: the natural `ib help <word>` guess resolves from the DB glossary.
    try {
        const client = await getClient();
        const e = await runGlossaryLookup(client, id);
        return { id, title: `${e.term} (glossary)`, body: e.definition ?? "" };
    }
    catch (err) {
        if (err instanceof CliError && err.exitCode === 5) {
            const ids = TOPICS.map((x) => x.id).join(", ");
            throw new CliError(`unknown topic: ${id}. Valid topics: ${ids}. For vocabulary try \`ib glossary lookup ${id}\`.`, 0, null, 5);
        }
        throw err;
    }
}
/**
 * Register the `ib help [topic]` command. NOTE: Commander's built-in implicit
 * `help` command is disabled in `program.ts` via `program.helpCommand(false)`
 * so this explicit command's action runs; the `-h/--help` option is separate
 * and unaffected. Unknown topics fall back to `ib glossary lookup` (DB).
 */
export function registerHelpCommands(program, getClient) {
    program
        .command("help [topic]")
        .description("Concept guides for AI users; an unknown topic falls back to `ib glossary lookup`.")
        .action(async (topic) => {
        try {
            writeJson(topic ? await runHelpTopic(topic, getClient) : runHelpList());
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map