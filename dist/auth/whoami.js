/**
 * Project a credentials profile into the stable `whoami` JSON shape.
 *
 * Pure function — no I/O, no JWT decode. The caller is responsible for
 * loading the profile from disk; this exists so the renderer can be
 * unit-tested without filesystem fixtures.
 */
export function renderWhoami(creds) {
    return {
        personId: creds.personId,
        activeCompany: {
            asiakasId: creds.ownerAsiakasId,
            name: creds.ownerAsiakasName,
        },
        endpoint: creds.endpoint,
    };
}
//# sourceMappingURL=whoami.js.map