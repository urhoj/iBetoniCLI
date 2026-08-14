import { warnNote } from "../output/json.js";

/**
 * Server-side row caps for the two list reads that clamp silently (fb#605).
 *
 * MIRRORED CONSTANTS, deliberately. The authoritative signal is the backend's
 * X-Result-Truncated header, which needs no mirror; these are the fallback for
 * a backend that predates it, and the source of the "you asked for more than
 * this route will give" warning — which has to fire BEFORE the response is
 * interpreted, so it cannot come from the response.
 *
 * Keep in step with:
 *   puminet5api/modules/changelog/changelogSql.js  effectiveListLimit
 *   puminet5api/modules/feedback/feedbackSql.js    effectiveListLimit
 * A stale mirror can only over-report truncation (one wasted page), never
 * under-report it — the direction that loses rows silently.
 */
export const CHANGELOG_LIST_CAP = 500;
export const CHANGELOG_LIST_DEFAULT = 100;
export const FEEDBACK_LIST_CAP = 200;
export const FEEDBACK_LIST_DEFAULT = 50;

/**
 * Warn when the caller asked for more rows than the route will ever return.
 *
 * This is the half that would actually have prevented the reported near-miss:
 * `--limit 1000` came back with 200 rows and looked like the whole table, and
 * nothing anywhere said the number had been clamped. Naming `--offset` in the
 * same breath matters because the flag is the only way to reach the rest.
 *
 * stderr only — the stdout JSON contract is untouched.
 */
export function warnIfLimitCapped(
  requested: unknown,
  cap: number,
  command: string,
  warn: (msg: string) => void = warnNote
): void {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= cap) return;
  warn(
    `[ib] ⚠ --limit ${n} exceeds this route's maximum of ${cap}; at most ${cap} rows are returned. ` +
      `The result is NOT the whole table — page through it with \`${command} --offset ${cap}\` (and so on), or narrow the query with a filter.`
  );
}
