/**
 * Shared CLI date helpers.
 *
 * `resolveDate` expands the relative aliases `today` / `yesterday` /
 * `tomorrow` to an ISO `YYYY-MM-DD` date in the **active company timezone
 * (Europe/Helsinki)** — the timezone every date flag is documented to use.
 * Computing the calendar date in UTC (the old behaviour) was off by one near
 * midnight Helsinki and on UTC CI runners. Any other input — including
 * already-formatted dates — is returned unchanged so the backend's validator
 * gets the final say. Used by every command that accepts a date flag (keikka,
 * schedule, vehicle).
 */
import { failWith } from "./output/json.js";
const COMPANY_TZ = "Europe/Helsinki";
// Constructing an Intl.DateTimeFormat loads ICU data for the locale + timezone
// and is the expensive half of `todayHelsinki`. Built on FIRST use (not at
// import time — most invocations resolve no date at all) and reused after.
let helsinkiDayFormat;
/**
 * The current calendar date in Europe/Helsinki as `YYYY-MM-DD`. `en-CA`
 * formats as ISO `YYYY-MM-DD`, and `timeZone` makes the day boundary follow
 * Helsinki wall-clock rather than the host/UTC clock.
 */
export function todayHelsinki(now = new Date()) {
    helsinkiDayFormat ??= new Intl.DateTimeFormat("en-CA", {
        timeZone: COMPANY_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return helsinkiDayFormat.format(now);
}
/**
 * A date flag (alias or ISO `YYYY-MM-DD`) → integer `yyyymmdd`, the day-key
 * shape the personPvm/driver routes take in URL paths and bodies. Distinct from
 * `message/daily`'s string-returning `toYyyymmdd`, which validates its input.
 */
export function toYyyymmddInt(date) {
    return Number(resolveDate(date).replace(/-/g, ""));
}
/** Shift an ISO `YYYY-MM-DD` by whole days, DST-safe (pure calendar math). */
export function addDaysISO(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
/**
 * A SQL `DATE` column as it comes back over JSON: UTC midnight, ms optional.
 *
 * Deliberately anchored to `T00:00:00` rather than matching any ISO datetime.
 * A real timestamp cannot be reduced to a calendar day without choosing a
 * timezone (22:00Z is already tomorrow in Helsinki), so guessing would be a
 * silent off-by-one on the exact boundary `todayHelsinki` exists to get right.
 * UTC midnight has no such ambiguity — it is what a date-only column serializes
 * to, and nothing else.
 */
const UTC_MIDNIGHT_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/;
export function resolveDate(input) {
    if (!input)
        return undefined;
    if (input === "today")
        return todayHelsinki();
    if (input === "yesterday")
        return addDaysISO(todayHelsinki(), -1);
    if (input === "tomorrow")
        return addDaysISO(todayHelsinki(), 1);
    // Accept a date column in the shape the READ commands emit it, so a row can be
    // edited and posted back without hand-trimming every date (feedback #357).
    // Without this the read-shape key aliases only move the rejection from a clean
    // client-side exit 4 to a backend 400 — one step later and harder to act on.
    const utcMidnight = UTC_MIDNIGHT_RE.exec(input);
    if (utcMidnight)
        return utcMidnight[1];
    return input;
}
/** Already carries a zone: trailing `Z` or a `±HH:MM` / `±HHMM` offset. */
const ZONED_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
/** `YYYY-MM-DD` with an optional `THH:MM[:SS[.mmm]]` wall-clock time. */
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?$/;
let helsinkiPartsFormat;
/**
 * Europe/Helsinki's UTC offset in ms at a given instant — DST-aware (+2 h EET
 * / +3 h EEST). Derived by formatting the instant as Helsinki wall-clock and
 * re-reading those components as if they were UTC; the difference IS the
 * offset. `hourCycle: "h23"` avoids the `hour12: false` quirk that renders
 * midnight as hour 24.
 */
function helsinkiOffsetMs(utcMs) {
    helsinkiPartsFormat ??= new Intl.DateTimeFormat("en-CA", {
        timeZone: COMPANY_TZ,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const p = {};
    for (const { type, value } of helsinkiPartsFormat.formatToParts(new Date(utcMs))) {
        if (type !== "literal")
            p[type] = Number(value);
    }
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}
/**
 * Normalize a TIMESTAMP flag to a UTC ISO instant (`…Z`) — the shape the
 * backend stores verbatim.
 *
 * Two accepted inputs, both unambiguous by the time they leave here:
 * - **Zoned** (`…Z`, `…+03:00`): a real instant already; converted to UTC.
 *   Previously the raw string was posted through and the DATETIME2 bind
 *   DROPPED the offset instead of applying it, so `12:00+03:00` stored as
 *   `12:00Z` — every backdated event skewed by 2–3 h, silently, with an HTTP
 *   200 and no signal (feedback #412).
 * - **Offset-less** (`2026-08-11T12:00`): read as **Europe/Helsinki**
 *   wall-clock, matching what every other date flag in this CLI documents.
 *
 * DST is resolved in two passes: take the offset at the naive guess, then
 * re-read it at the corrected instant. On the spring-forward gap the result
 * lands just after the jump; on the autumn repeat it picks the first (EEST)
 * occurrence.
 *
 * Component ranges are checked explicitly because `Date.UTC` silently ROLLS
 * OVER — `2026-13-45` would otherwise become a valid instant in 2027.
 */
export function resolveDateTime(input, flag = "--time") {
    if (!input)
        return undefined;
    const value = input.trim();
    const bad = (why) => failWith(`${flag}: ${why}: "${input}". Use Helsinki wall-clock (2026-08-11T12:00) or a zoned form (2026-08-11T12:00:00+03:00, 2026-08-11T09:00:00Z).`, 4);
    if (ZONED_RE.test(value)) {
        const ms = Date.parse(value);
        if (Number.isNaN(ms))
            bad("not a valid ISO 8601 timestamp");
        return new Date(ms).toISOString();
    }
    const m = LOCAL_DATETIME_RE.exec(value);
    if (!m)
        bad("not a valid ISO 8601 timestamp");
    const [, y, mo, d, h = "00", mi = "00", s = "00", frac = "0"] = m;
    const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
    if (month < 1 || month > 12)
        bad("month out of range");
    if (day < 1 || day > 31)
        bad("day out of range");
    if (hour > 23 || minute > 59 || second > 59)
        bad("time out of range");
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, Number(frac.padEnd(3, "0")));
    const guess = wallAsUtc - helsinkiOffsetMs(wallAsUtc);
    return new Date(wallAsUtc - helsinkiOffsetMs(guess)).toISOString();
}
const MONTH_RE = /^\d{4}-\d{2}$/;
/** Expand `YYYY-MM` to { from: first day, to: last day } (leap-year aware). */
export function monthRange(month) {
    if (!MONTH_RE.test(month)) {
        throw new Error(`--month must be YYYY-MM, got "${month}"`);
    }
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}
/** Expand a start date to the 7-day window [start, start+6]. */
export function weekRange(start) {
    return { from: start, to: addDaysISO(start, 6) };
}
//# sourceMappingURL=dates.js.map