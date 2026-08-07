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
const COMPANY_TZ = "Europe/Helsinki";

// Constructing an Intl.DateTimeFormat loads ICU data for the locale + timezone
// and is the expensive half of `todayHelsinki`. Built on FIRST use (not at
// import time — most invocations resolve no date at all) and reused after.
let helsinkiDayFormat: Intl.DateTimeFormat | undefined;

/**
 * The current calendar date in Europe/Helsinki as `YYYY-MM-DD`. `en-CA`
 * formats as ISO `YYYY-MM-DD`, and `timeZone` makes the day boundary follow
 * Helsinki wall-clock rather than the host/UTC clock.
 */
export function todayHelsinki(now: Date = new Date()): string {
  helsinkiDayFormat ??= new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return helsinkiDayFormat.format(now);
}

/** Shift an ISO `YYYY-MM-DD` by whole days, DST-safe (pure calendar math). */
export function addDaysISO(iso: string, days: number): string {
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

export function resolveDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input === "today") return todayHelsinki();
  if (input === "yesterday") return addDaysISO(todayHelsinki(), -1);
  if (input === "tomorrow") return addDaysISO(todayHelsinki(), 1);
  // Accept a date column in the shape the READ commands emit it, so a row can be
  // edited and posted back without hand-trimming every date (feedback #357).
  // Without this the read-shape key aliases only move the rejection from a clean
  // client-side exit 4 to a backend 400 — one step later and harder to act on.
  const utcMidnight = UTC_MIDNIGHT_RE.exec(input);
  if (utcMidnight) return utcMidnight[1];
  return input;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/** Expand `YYYY-MM` to { from: first day, to: last day } (leap-year aware). */
export function monthRange(month: string): { from: string; to: string } {
  if (!MONTH_RE.test(month)) {
    throw new Error(`--month must be YYYY-MM, got "${month}"`);
  }
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** Expand a start date to the 7-day window [start, start+6]. */
export function weekRange(start: string): { from: string; to: string } {
  return { from: start, to: addDaysISO(start, 6) };
}
