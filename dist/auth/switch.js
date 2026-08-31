import { CliError } from "../api/errors.js";
import { createStore, defaultCredentialsPath } from "./store.js";
import { postJson } from "./http.js";
import { failWith } from "../output/json.js";
import { getEmbeddedCtx } from "../embedded.js";
import { notLoggedInMessage } from "./notLoggedIn.js";
/**
 * Guard for PERSISTED company switches (`ib auth switch` / `ib company switch`)
 * under the session write-lock. These bypass `createApiClient` (credential-store
 * path), so the client's non-GET gate never sees them — without this guard,
 * read-only mode would silently change tenant context and persist a rotated
 * JWT. The EPHEMERAL `--company <id>` switch stays allowed: it is per-command,
 * never persisted, and writes made through it still hit the client gate.
 */
export function assertPersistedSwitchAllowed(readOnly) {
    // An EMBEDDED invocation (`IB_EXEC_INPROCESS` / any library embedder) has no
    // credentials file of its OWN — `defaultCredentialsPath()` resolves to the
    // HOST process's store. A persisted switch there would rotate and overwrite
    // the host server's session JWT on behalf of a remote caller, who supplied
    // only a bearer token (feedback #316). Identity in the embedded path comes
    // from EmbeddedCtx, never from disk, so this operation is meaningless there
    // regardless of the read-only flag — refuse before touching the store.
    if (getEmbeddedCtx()) {
        throw new CliError("Refused: `company switch` persists a rotated JWT to the local credentials file, which does not exist for an embedded/remote invocation. Pass the target company per request instead (global --company <id>).", 0, { code: "EMBEDDED_BLOCKED" }, 3);
    }
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
    const body = (await postJson(opts.endpoint, "/api/company-selection/switch", opts.jwt, { newAsiakasId: opts.toAsiakasId }, "Company switch"));
    // Guard the persisted fields (the impersonate flows do the same): a 2xx body
    // without a token must never reach store.save as `jwt: undefined`.
    if (!body.token) {
        throw new CliError("Company switch failed: response missing token", 0, body, 1);
    }
    return {
        jwt: body.token,
        ownerAsiakasId: body.ownerAsiakasId,
        ownerAsiakasName: body.ownerAsiakasName,
    };
}
/**
 * The whole PERSISTED company switch, end to end: read-only guard → load the
 * credentials profile → {@link performSwitch} → persist the rotated JWT and the
 * new owner identity → return the `ok`/`activeCompany` envelope.
 *
 * `ib auth switch` and `ib company switch` are the same operation reached from
 * two groups (the `company` path is the discoverable one; the `auth` path sits
 * beside the other credential-store commands), so they share this body rather
 * than each keeping a copy that can drift.
 */
export async function runPersistedSwitch(toAsiakasId, isReadOnly) {
    assertPersistedSwitchAllowed(isReadOnly);
    const store = createStore(defaultCredentialsPath());
    const creds = await store.load();
    if (!creds) {
        // Endpoint-agnostic (this switch always targets the ACTIVE session, no
        // --endpoint override to name) — routes through the shared message
        // builder for one source of truth (fb#1102), text is unchanged.
        failWith(notLoggedInMessage(), 2);
    }
    const next = await performSwitch({
        endpoint: creds.endpoint,
        jwt: creds.jwt,
        toAsiakasId,
    });
    await store.save({
        ...creds,
        jwt: next.jwt,
        ownerAsiakasId: next.ownerAsiakasId,
        ownerAsiakasName: next.ownerAsiakasName,
    });
    return {
        ok: true,
        activeCompany: {
            asiakasId: next.ownerAsiakasId,
            name: next.ownerAsiakasName,
        },
    };
}
//# sourceMappingURL=switch.js.map