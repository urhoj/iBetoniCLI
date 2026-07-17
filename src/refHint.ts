/**
 * feedback #230 — sibling-404 disambiguation for the two identically-shaped,
 * overlapping-id command trees (`ib dev feedback get N` / `ib dev changelog get N`).
 *
 * When a get/write for id N returns 404, probe the OTHER table for the same id;
 * if a row exists there, augment the error with a "did you mean the other
 * command" hint. This catches the BARE-number wrong-table case while the fb/cl
 * id ranges are still disjoint. Once the ranges overlap it can no longer fire
 * (the id resolves to a real, wrong row → no 404) — in that regime the `fb#`/`cl#`
 * input anchor ({@link parseRefId}) is the guard. Best-effort: any error in the
 * probe → null, so it never masks the original failure.
 */
import type { ApiClient } from "./api/client.js";
import { CliError } from "./api/errors.js";
import type { RefType } from "./targets.js";

const SIBLING: Record<
  RefType,
  { path: (id: number) => string; table: string; cmd: string }
> = {
  feedback: { path: (id) => `/api/feedback/${id}`, table: "cliFeedback", cmd: "ib dev feedback get" },
  changelog: { path: (id) => `/api/changelog/${id}`, table: "devChangelog", cmd: "ib dev changelog get" },
};

/**
 * Probe the sibling table for `id`. Returns a "did you mean" hint if a row
 * exists there, else null (including on any probe error).
 *
 * @param sibling the OTHER table to probe (not the command's own type).
 */
export async function siblingRefHint(
  client: ApiClient,
  id: number,
  sibling: RefType
): Promise<string | null> {
  const s = SIBLING[sibling];
  try {
    await client.get(s.path(id));
    return `${id} exists in ${s.table} — did you mean: ${s.cmd} ${id}`;
  } catch {
    return null;
  }
}

/**
 * Run a get/write op for `id`; if it 404s, add {@link siblingRefHint} to the
 * surfaced error. Exit code, status, and body are preserved — only `hint` is
 * added (and only when the id actually exists in the sibling table).
 */
export async function runWithSiblingHint<T>(
  client: ApiClient,
  id: number,
  sibling: RefType,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CliError && e.statusCode === 404) {
      const hint = await siblingRefHint(client, id, sibling);
      if (hint) throw new CliError(e.message, e.statusCode, e.body, e.exitCode, hint);
    }
    throw e;
  }
}
