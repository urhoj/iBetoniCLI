import { CliError } from "./api/errors.js";
const SIBLING = {
    feedback: { path: (id) => `/api/feedback/${id}`, table: "cliFeedback", cmd: "ib dev feedback get" },
    changelog: { path: (id) => `/api/changelog/${id}`, table: "devChangelog", cmd: "ib dev changelog get" },
};
/**
 * Probe the sibling table for `id`. Returns a "did you mean" hint if a row
 * exists there, else null (including on any probe error).
 *
 * @param sibling the OTHER table to probe (not the command's own type).
 */
export async function siblingRefHint(client, id, sibling) {
    const s = SIBLING[sibling];
    try {
        await client.get(s.path(id));
        return `${id} exists in ${s.table} — did you mean: ${s.cmd} ${id}`;
    }
    catch {
        return null;
    }
}
/**
 * Run a get/write op for `id`; if it 404s, add {@link siblingRefHint} to the
 * surfaced error. Exit code, status, and body are preserved — only `hint` is
 * added (and only when the id actually exists in the sibling table).
 */
export async function runWithSiblingHint(client, id, sibling, fn) {
    try {
        return await fn();
    }
    catch (e) {
        if (e instanceof CliError && e.statusCode === 404) {
            const hint = await siblingRefHint(client, id, sibling);
            if (hint)
                throw new CliError(e.message, e.statusCode, e.body, e.exitCode, hint);
        }
        throw e;
    }
}
//# sourceMappingURL=refHint.js.map