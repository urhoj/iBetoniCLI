/**
 * The ONE owner of the CLI's person-row vocabulary (fb#692): list rows carry the
 * short `name` (first + last joined) and `email`. Canonical by decision — it is
 * what every person-bearing list already returned. `customer person list`
 * additionally passes the raw `person*` columns through as aliases (fb#621).
 * Project through here so a new command cannot invent a third spelling.
 */
export function projectPersonName(r) {
    return {
        name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
        email: r.personEmail || null,
    };
}
//# sourceMappingURL=personRow.js.map