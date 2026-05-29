/**
 * Shared CLI date helpers.
 *
 * `resolveDate` expands the relative aliases `today` / `yesterday` /
 * `tomorrow` to an ISO `YYYY-MM-DD` date (local time). Any other input —
 * including already-formatted dates — is returned unchanged so the backend's
 * validator gets the final say. Used by every command that accepts a date
 * flag (keikka, schedule, vehicle).
 */
export function resolveDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input === "today" || input === "yesterday" || input === "tomorrow") {
    const d = new Date();
    if (input === "yesterday") d.setDate(d.getDate() - 1);
    if (input === "tomorrow") d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return input;
}
