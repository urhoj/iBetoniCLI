/** The backend's person columns, as every person-bearing route sends them. */
export interface PersonNameFields {
  personFirstName?: string | null;
  personLastName?: string | null;
  personEmail?: string | null;
}

/**
 * The ONE owner of the CLI's person-row vocabulary (fb#692): list rows carry the
 * short `name` (first + last joined) and `email`. Canonical by decision — it is
 * what every person-bearing list already returned. `customer person list`
 * additionally passes the raw `person*` columns through as aliases (fb#621).
 * Project through here so a new command cannot invent a third spelling.
 */
export function projectPersonName(r: PersonNameFields): { name: string; email: string | null } {
  return {
    name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
    email: r.personEmail || null,
  };
}
