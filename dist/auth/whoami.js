/**
 * Project a credentials profile into the stable `whoami` JSON shape.
 *
 * Pure function — no I/O, no JWT decode. The caller loads the profile from disk.
 */
export function renderWhoami(creds) {
    const out = {
        personId: creds.personId,
        activeCompany: { asiakasId: creds.ownerAsiakasId, name: creds.ownerAsiakasName },
        endpoint: creds.endpoint,
    };
    if (creds.impersonation)
        out.impersonating = creds.impersonation;
    return out;
}
//# sourceMappingURL=whoami.js.map