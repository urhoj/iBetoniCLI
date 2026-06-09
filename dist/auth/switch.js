import { CliError, exitCodeFromStatus } from "../api/errors.js";
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