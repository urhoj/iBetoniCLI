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

/**
 * The current calendar date in Europe/Helsinki as `YYYY-MM-DD`. `en-CA`
 * formats as ISO `YYYY-MM-DD`, and `timeZone` makes the day boundary follow
 * Helsinki wall-clock rather than the host/UTC clock.
 */
export function todayHelsinki(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Shift an ISO `YYYY-MM-DD` by whole days, DST-safe (pure calendar math). */
function shiftIsoDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input === "today") return todayHelsinki();
  if (input === "yesterday") return shiftIsoDays(todayHelsinki(), -1);
  if (input === "tomorrow") return shiftIsoDays(todayHelsinki(), 1);
  return input;
}

/** Shift an ISO YYYY-MM-DD by whole days (public alias of the internal shift). */
export function addDaysISO(iso: string, days: number): string {
  return shiftIsoDays(iso, days);
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
  return { from: start, to: shiftIsoDays(start, 6) };
}
