import { warnNote } from "../output/json.js";
import type { ListEnvelope } from "./envelopes.js";

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

/**
 * Say out loud that a page came back at the route's HARD cap (fb#1439).
 *
 * The gap between the two warnings above. {@link warnIfLimitCapped} fires only
 * when the caller ASKED for more than the cap — `if (n <= cap) return` — so
 * `--limit 250` got the loud, correct advice while `--limit 200` against 234
 * rows was silent, though equally incomplete. The default limit makes it worse,
 * because the common case passes no limit at all and hits the same silence at 50.
 *
 * Why not {@link warnIfTruncated}, which already reads the envelope: it is wrong
 * here twice over. Its remedy is "re-run with a higher --limit", which cannot
 * work against a HARD cap — only `--offset` reaches the rest. And it prefers
 * `env.hint`, which on `feedback list` describes TEXT elision ("description /
 * resolution over 200 chars show head+tail") while `env.truncated` means missing
 * ROWS; attaching that hint to a missing-rows warning is worse than silence,
 * because it reads like the explanation. So this one deliberately ignores `hint`
 * and states the cap it was given.
 *
 * Real cost of the silence: scripts/audit-feedback-shipped.js (fb#1435) shipped
 * scanning 200 of 234 rows. `--unresolved` merges newest-first and then slices,
 * so the rows it lost were the OLDEST — precisely what an "already fixed and
 * forgotten" audit exists to find. It missed fb#345 until this was found by hand.
 *
 * stderr only — the stdout JSON contract is untouched.
 */
export function warnIfCapReached(
  env: Pick<ListEnvelope<unknown>, "truncated" | "count"> | null | undefined,
  opts: { effective: number; cap: number; command: string },
  warn: (msg: string) => void = warnNote
): void {
  if (env?.truncated !== true) return;
  const { effective, cap, command } = opts;
  // `truncated` only means "the page came back full, there may be more" — it does NOT mean the
  // ROUTE cap was hit. Attributing every full page to the hard cap would produce a confidently
  // wrong remedy on a small --limit: `--limit 5` would be told to use `--offset 200` and that
  // raising --limit cannot help, when raising it is exactly the fix. Two situations, two remedies.
  warn(
    effective >= cap
      ? `[ib] ⚠ \`${command}\` returned ${env.count} row(s) and hit this route's maximum of ${cap}. ` +
          `The result is NOT the whole set — page through it with \`${command} --offset ${cap}\` (and so on), ` +
          `or narrow the query with a filter. Raising --limit will not help; ${cap} is a hard cap.`
      : `[ib] ⚠ \`${command}\` returned a FULL page of ${env.count} at --limit ${effective}, so there are ` +
          `probably more. Raise --limit (up to ${cap}) or page on with \`${command} --offset ${effective}\`.`
  );
}

/**
 * Say out loud that a list came back CAPPED (fb#641).
 *
 * The twin of {@link warnIfLimitCapped}, for the other direction: that one fires
 * when the caller ASKED for more than the route gives, this one when the caller
 * asked for nothing in particular and the default cap bit anyway. Only the
 * response knows that, so it reads the envelope the backend already sends.
 *
 * Why a warning rather than a bigger default: the payload has carried
 * `truncated`/`hint` since fb#606 and it changed nothing, because a caller who
 * does not think to check `truncated` also does not think to raise `--limit`.
 * The reported failure was not a caller who read the flag and ignored it — it
 * was `ib dev schema procs` answering with 200 of 535 rows, exit 0, and a
 * derived index that then "proved" whole families of procs did not exist. Raising
 * the default only moves that cliff (see puminet5api utils/listTruncation.js,
 * which rejects the same shortcut for the same reason); stderr removes it,
 * because a truncated read now costs one line the caller cannot not see.
 *
 * Prefers the backend's own `hint` — it names the route's real maximum, so a cap
 * that later changes server-side cannot leave a stale number mirrored here.
 *
 * stderr only — the stdout JSON contract is untouched.
 */
export function warnIfTruncated(
  env: Pick<ListEnvelope<unknown>, "truncated" | "count" | "hint"> | null | undefined,
  command: string,
  warn: (msg: string) => void = warnNote
): void {
  if (env?.truncated !== true) return;
  // The backend's hint already says "this is NOT the full list" and names the
  // route's real maximum, so do not restate either — the fallback carries both
  // only for a backend that sends no hint at all.
  const detail =
    typeof env.hint === "string" && env.hint
      ? env.hint
      : "this is NOT the whole list — re-run with a higher --limit, or narrow it with --search";
  warn(
    `[ib] ⚠ \`${command}\` returned ${env.count} row(s) and was TRUNCATED: ${detail}. ` +
      `Anything derived from this page (a "no such object exists" conclusion especially) is unsafe until the read is complete.`
  );
}
