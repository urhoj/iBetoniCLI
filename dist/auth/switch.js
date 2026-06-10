import { CliError, exitCodeFromStatus } from "../api/errors.js";
/**
 * Guard for PERSISTED company switches (`ib auth switch` / `ib company switch`)
 * under the session write-lock. These bypass `createApiClient` (credential-store
 * path), so the client's non-GET gate never sees them — without this guard,
 * read-only mode would silently change tenant context and persist a rotated
 * JWT. The EPHEMERAL `--company <id>` switch stays allowed: it is per-command,
 * never persisted, and writes made through it still hit the client gate.
 */
export function assertPersistedSwitchAllowed(readOnly) {
    if (!readOnly)
        return;
    // Same READ_ONLY_BLOCKED code as the client gate: `code` in the stderr
    // envelope marks a client-side refusal vs a real HTTP 403 (both exit 3).
    throw new CliError("Refused: company switch persists a rotated JWT and read-only mode is active (--read-only / IB_READ_ONLY). Use the per-command global --company <id> ephemeral context instead.", 0, { code: "READ_ONLY_BLOCKED" }, 3);
}
/**
 * Switch the active company by POSTing the target `newAsiakasId` to
 * `/api/company-selection/switch`. The backend re-issues a JWT bound to
 * the new tenant; the caller must persist the new token and updated
 * owner identity in the credentials store.
 *
 * NOTE: the backend reads the body field `newAsiakasId` (see
 * puminet5api/routes/companySelectionRoutes.js); sending `asiakasId`
 * yields HTTP 400 "newAsiakasId is required".
 */
export async function performSwitch(opts) {
    const res = await fetch(`${opts.endpoint}/api/company-selection/switch`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.jwt}`,
        },
        body: JSON.stringify({ newAsiakasId: opts.toAsiakasId }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new CliError(`Company switch failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status, detail || null, exitCodeFromStatus(res.status));
    }
    const body = (await res.json());
    return {
        jwt: body.token,
        ownerAsiakasId: body.ownerAsiakasId,
        ownerAsiakasName: body.ownerAsiakasName,
    };
}
//# sourceMappingURL=switch.js.map