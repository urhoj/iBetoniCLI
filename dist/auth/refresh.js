/**
 * Exchange a (potentially near-expiry) JWT for a freshly issued one.
 *
 * Hits `POST /api/auth/refresh-token` with the current JWT as the
 * `Authorization: Bearer` header — the backend re-issues a token using the
 * same claims provided the original is still verifiable (within the grace
 * window). Throws on any non-200 response so the caller can fall back to a
 * full `ib auth login` reflow.
 */
export async function refreshToken({ endpoint, currentJwt, }) {
    const res = await fetch(`${endpoint}/api/auth/refresh-token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${currentJwt}`,
            "Content-Type": "application/json",
        },
    });
    if (res.status !== 200) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Refresh failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    const body = (await res.json());
    const newJwt = body.token ?? body.jwt ?? body.access_token;
    if (!newJwt || typeof newJwt !== "string") {
        throw new Error("Refresh failed: response missing token");
    }
    return newJwt;
}
//# sourceMappingURL=refresh.js.map