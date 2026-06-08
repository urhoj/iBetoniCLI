/**
 * Field-level diff for read-merge-write commands.
 *
 * Used by mutation `--dry-run` previews: a command that already fetched the
 * current row builds the merged next-state body, then reports exactly which
 * fields would change — without calling the backend at all. Computing the diff
 * locally (rather than POSTing `X-Dry-Run`) is safe-by-construction: it cannot
 * persist anything, so it is immune to the server-side dry-run guard being
 * absent on an endpoint (which would otherwise let a "preview" write through).
 */

/** A single changed field: previous value → would-be value. */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

/** Map of changed field name → {@link FieldChange}. Empty = no-op write. */
export type FieldDiff = Record<string, FieldChange>;

/**
 * Normalize a value for change comparison so cosmetically-equal values are not
 * reported as changes:
 *  - `null` / `undefined` / `""` collapse to `null` (the DB's "unset");
 *  - everything else compares by its string form, so the FE's `"28"` does not
 *    read as a change vs the DB's numeric `28`.
 */
function normalize(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

/**
 * Compare `current` against `next` over the given `fields` and return only the
 * keys whose normalized value differs. Order follows `fields`. Values in the
 * result are the raw (un-normalized) originals so the caller sees the real
 * before/after.
 *
 * @param current The row as currently persisted.
 * @param next The merged would-be row.
 * @param fields The writable field names to consider (ignore read-only cols).
 */
export function diffFields(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  fields: readonly string[]
): FieldDiff {
  const diff: FieldDiff = {};
  for (const key of fields) {
    if (normalize(current[key]) !== normalize(next[key])) {
      diff[key] = { from: current[key] ?? null, to: next[key] ?? null };
    }
  }
  return diff;
}
