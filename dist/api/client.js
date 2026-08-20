import { randomUUID } from "node:crypto";
import { CliError, errorMessage, exitCodeFromStatus } from "./errors.js";
import { looksLikeHtml, summarizeHtmlErrorBody } from "./htmlErrorBody.js";
import { recordRequest, statsEnabled } from "../stats.js";
import { getAmbientCommandPath } from "../commandContext.js";
import { warnNote } from "../output/json.js";
/**
 * BetoniJerry umbrella tenant (`@ibetoni/constants` BETONIJERRY.OWNER_ASIAKAS_ID).
 * Writes resolved against it touch the shared umbrella org, so the acting-as
 * diagnostic flags it loudly. Inlined (stable tenant id) to keep the client
 * free of the CJS constants require on its hot path.
 */
const BETONIJERRY_UMBRELLA_ASIAKAS_ID = 1349;
/**
 * Derive a human/agent-readable message from a parsed error body. `sendError`
 * returns `{ error: "<string>" }`, but other layers (rate-limit, oauth) may
 * nest it (`{ error: { message, code } }`) or send `{ message }`. The old
 * `String(parsed.error)` turned a nested object into the literal
 * `"[object Object]"`, defeating the machine-parseable-error contract — so dig
 * out a real string before falling back to `HTTP <status>`.
 */
function errorMessageFromBody(parsed, status, contentType = "") {
    const fallback = `HTTP ${status}`;
    if (typeof parsed === "string" && parsed) {
        // ~130 chars of `<html><head><title>502 Bad Gateway...` inside the envelope's
        // `error` string is pure noise on the CLI's machine-readable channel, and a
        // CF challenge page or a 5xx carrying a ray id would be far worse. The full
        // body stays reachable under --verbose, which dumps it raw (fb#577).
        if (looksLikeHtml(parsed, contentType))
            return summarizeHtmlErrorBody(parsed, status);
        return parsed;
    }
    if (!parsed || typeof parsed !== "object")
        return fallback;
    const body = parsed;
    const err = body.error ?? body.message;
    if (typeof err === "string" && err)
        return err;
    if (err && typeof err === "object") {
        const nested = err.message ??
            err.error;
        if (typeof nested === "string" && nested)
            return nested;
        return JSON.stringify(err);
    }
    return fallback;
}
/**
 * HTTP header values must be a ByteString (Latin-1, code points 0–255). Free-text
 * header values — notably --reason (`X-Action-Reason`) and --idempotency-key — can
 * carry Unicode punctuation (em/en dashes, curly quotes, …, €) that makes the
 * runtime `fetch` throw "Cannot convert argument to a ByteString" BEFORE the
 * request is sent, crashing the whole command client-side. Transliterate the
 * common offenders to ASCII and replace any remaining >255 code point with '?',
 * so a reason with fancy characters degrades gracefully instead of aborting the
 * call. Latin-1 text (incl. Finnish ä/ö/å) passes through unchanged.
 */
export function sanitizeHeaderValue(value) {
    // Fast path: only printable Latin-1 code points (U+0020-U+00FF) present.
    if (!/[^\u0020-\u00ff]/.test(value))
        return value;
    return value
        .replace(/[\u2010-\u2015]/g, "-") // hyphens & dashes
        .replace(/[\u2018\u2019\u201a\u201b]/g, "'") // single curly quotes
        .replace(/[\u201c\u201d\u201e\u201f]/g, '"') // double curly quotes
        .replace(/\u2026/g, "...") // ellipsis
        .replace(/\u20ac/g, "EUR") // euro sign
        .replace(/[^\u0020-\u00ff]/g, "?"); // remaining >255 + control chars
}
/**
 * Backoff before each retry of an idempotent request whose fetch REJECTED
 * (feedback #318). Two retries, deliberately short: `ib` is invoked
 * interactively and in batch loops, so a long backoff would read as a hang.
 * Covers the observed flap shape — failures ~11s apart that cleared on an
 * immediate re-run — without turning a genuinely-down endpoint into a stall
 * (worst case adds ~1s before the same exit 7). `IB_NO_RETRY=1` disables.
 */
const NETWORK_RETRY_BACKOFF_MS = [250, 750];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function createApiClient({ endpoint, token, version, requestId, onRefresh, readOnly = false, actingAs, quiet = false, verbose = false, printPayload = false, }) {
    const platform = `${process.platform} node-${process.versions.node}`;
    const userAgent = `ib-cli/${version} (${platform})`;
    let currentToken = token;
    let actingAsAnnounced = false;
    // The X-Request-ID actually sent on the most recent fetch (a fresh UUID per
    // request unless the caller pinned one) — captured so the --verbose failure
    // diagnostic can print the id to correlate with Sentry/backend logs.
    let lastRequestId = requestId;
    /** Set from the X-Result-* headers on every response; null when absent (fb#605). */
    let lastListMeta = null;
    /**
     * Print the acting-as company once, before the process's first write. No-op
     * when quiet, when no identity was supplied, or already announced.
     *
     * "acting as", not "→ asiakasId": this names the token's company lens, which
     * for a cross-tenant `--asiakas <id>` write is NOT the row's target (the write
     * lands on `<id>`, not on the lens). The old "write → asiakasId N" arrow read
     * as a destination and masked wrong-target mistakes (feedback #118); the HTTP
     * layer can't see per-command targets, so we frame it as the auth lens.
     */
    function announceActingAs() {
        if (quiet || !actingAs || actingAsAnnounced)
            return;
        actingAsAnnounced = true;
        const name = actingAs.ownerAsiakasName ? ` (${actingAs.ownerAsiakasName})` : "";
        const umbrella = actingAs.ownerAsiakasId === BETONIJERRY_UMBRELLA_ASIAKAS_ID
            ? "  ⚠ BetoniJerry umbrella tenant"
            : "";
        warnNote(`[ib] write · acting as asiakasId ${actingAs.ownerAsiakasId}${name}${umbrella}`);
    }
    /**
     * `--print-payload`: emit the resolved request to stderr before it is sent
     * (fb#636). One JSON line on stderr — never stdout, so the data contract is
     * untouched (same channel as the acting-as and `--stats` diagnostics).
     *
     * Two deliberate distortions of the literal outgoing bytes, both so the line
     * cannot itself become a silent lie:
     *  - `Authorization` is redacted. The whole point is to paste this into a bug
     *    report, and a full superuser JWT has leaked that way before.
     *  - `X-Request-ID` renders as a placeholder unless the caller pinned one with
     *    `--request-id`. `buildHeaders` mints a fresh UUID per ATTEMPT, so any
     *    concrete value printed here would differ from the one actually sent — and
     *    a plausible-but-wrong correlation id is worse than none.
     *
     * Safe to call before the read-only gate: `buildHeaders` is PURE (only
     * `doFetch`, the single real-send site, records `lastRequestId`), so a
     * previewed-then-refused request cannot leave behind a correlation id that was
     * never on the wire.
     */
    function emitResolvedPayload(method, path, payload, opts) {
        const headers = buildHeaders(opts.headers, payload !== undefined);
        headers.Authorization = "Bearer ***";
        if (!requestId)
            headers["X-Request-ID"] = "<minted per attempt>";
        let body;
        if (payload !== undefined) {
            try {
                body = JSON.parse(payload);
            }
            catch {
                body = payload;
            }
        }
        warnNote(`[ib] payload · ${JSON.stringify({
            method,
            path,
            headers,
            ...(payload !== undefined ? { body } : {}),
        })}`);
    }
    function buildHeaders(extra = {}, withBody = false) {
        const ambientCommand = getAmbientCommandPath();
        const merged = {
            Authorization: `Bearer ${currentToken}`,
            "User-Agent": userAgent,
            "X-Request-ID": requestId || randomUUID(),
            ...(ambientCommand ? { "X-Ib-Command": ambientCommand } : {}),
            ...(withBody ? { "Content-Type": "application/json" } : {}),
            ...extra,
        };
        // Header values must be a Latin-1 ByteString or `fetch` throws before the
        // request is sent. Sanitize every value (no-op for already-clean ASCII /
        // Latin-1) so a --reason with an em dash, curly quote, € etc. can't crash
        // the command. Central choke point: all requests flow through here.
        for (const key of Object.keys(merged)) {
            merged[key] = sanitizeHeaderValue(merged[key]);
        }
        return merged;
    }
    // `payload` is the already-serialized body (undefined = no body) — serialized
    // ONCE in `request` so the 401-refresh retry re-sends the same bytes instead
    // of re-running JSON.stringify over the identical object.
    async function doFetch(method, path, payload, opts) {
        const headers = buildHeaders(opts.headers, payload !== undefined);
        // The ONLY writer of `lastRequestId`: recorded here, at the single site that
        // actually puts bytes on the wire, so the --verbose correlation id can never
        // name a request that was not sent. (A 401-refresh retry re-enters here and
        // correctly overwrites it with the retry's own id.)
        lastRequestId = headers["X-Request-ID"];
        return fetch(`${endpoint}${path}`, { method, headers, body: payload });
    }
    // A fetch rejection (DNS failure, connection refused, TLS error, …) is a
    // network problem, not an HTTP status — surface it as a CliError mapped to
    // the documented `7` network exit code instead of letting a raw TypeError
    // escape to the generic exit-1 handler.
    //
    // Transient flaps are retried first (feedback #318): three `sijainti geocode`
    // calls failed inside a 22-second window and all three succeeded on an
    // immediate re-run, silently punching holes in a 12-address batch that read
    // as "no result for this address" rather than "never evaluated".
    //
    // ONLY IDEMPOTENT requests are retried — GET, and the read-over-POST reads
    // that mark themselves `opts.read`. A fetch rejection cannot distinguish
    // "never left the machine" from "server processed it, reply lost", so
    // retrying a real mutation risks double-writing. Mutations keep the old
    // fail-fast behaviour; a caller who wants one retried can supply
    // --idempotency-key and re-run deliberately.
    async function fetchOrNetworkError(method, path, payload, opts) {
        const idempotent = method === "GET" || !!opts.read;
        const attempts = idempotent && !process.env.IB_NO_RETRY ? NETWORK_RETRY_BACKOFF_MS.length + 1 : 1;
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return await doFetch(method, path, payload, opts);
            }
            catch (e) {
                lastError = e;
                if (attempt === attempts - 1)
                    break;
                const waitMs = NETWORK_RETRY_BACKOFF_MS[attempt];
                if (!quiet) {
                    // stderr only — the stdout JSON contract is never polluted. Silence
                    // would make a retried call indistinguishable from a clean one.
                    warnNote(`[ib] network error (${errorMessage(e)}) — retrying ${method} ${path} in ${waitMs}ms (attempt ${attempt + 2}/${attempts})`);
                }
                await sleep(waitMs);
            }
        }
        const detail = errorMessage(lastError);
        const retried = attempts > 1 ? ` (after ${attempts} attempts)` : "";
        throw new CliError(`Network error: ${detail}${retried}`, 0, null, 7);
    }
    async function request(method, path, body, opts = {}) {
        // Serialized ONCE, up here rather than after the gates, so `--print-payload`
        // can show the very bytes the fetch will carry (and the 401-refresh retry
        // re-sends the same string instead of re-running JSON.stringify).
        const payload = method !== "GET" && body !== undefined ? JSON.stringify(body) : undefined;
        // Ahead of the read-only gate on purpose: `--read-only --print-payload` must
        // SHOW the write and then refuse it. Printing after the gate would surface
        // the refusal alone — which is precisely the fb#636 dead end, where the
        // assembled body is thrown away unseen.
        if (printPayload)
            emitResolvedPayload(method, path, payload, opts);
        // Read-only write-lock: refuse every mutation before it leaves the process.
        // Mapped to exit 3 (forbidden) — the closest documented contract code for a
        // refused write. GETs pass through, so reads (and the read half of a
        // read-merge-write) still work.
        // `meta` requests (e.g. `ib feedback`) are not domain mutations — they are
        // whitelisted past the lock so feedback can be filed even under read-only.
        if (readOnly && method !== "GET" && !opts.meta && !opts.read) {
            // fb#775 facet 2: a caller passing --dry-run under read-only got the same
            // generic refusal as any other write, and read it as "the write was
            // blocked" without learning that --dry-run gives no preview either (it is
            // still a POST). Name that explicitly when the header is present.
            const dryRunNote = opts.headers?.["X-Dry-Run"] === "1"
                ? " This also blocks --dry-run, since it is still a POST; unset IB_READ_ONLY / drop --read-only to preview."
                : "";
            // body.code surfaces as `code` in the stderr envelope — a machine-parseable
            // marker distinguishing this client-side refusal (statusCode 0) from a real
            // server-side HTTP 403, which shares exit code 3.
            throw new CliError(`Refused: '${method} ${path}' is a write and read-only mode is active (--read-only / IB_READ_ONLY).${dryRunNote}`, 0, { code: "READ_ONLY_BLOCKED" }, 3);
        }
        // Announce the write target once, after the read-only gate (a refused write
        // must not claim to have acted) and before the request leaves the process.
        // Meta requests skip this — they don't write tenant data under any company lens.
        // Read-over-POST requests skip this — they don't mutate tenant data.
        if (method !== "GET" && !opts.meta && !opts.read)
            announceActingAs();
        const startedAt = Date.now();
        let res = await fetchOrNetworkError(method, path, payload, opts);
        // Single-retry refresh path: only the first 401 triggers a refresh+retry.
        // A second consecutive 401 (post-refresh) falls through to the normal
        // error mapping so callers know to re-run `ib auth login`. A failing
        // refresh is itself an auth problem → CliError mapped to exit 2.
        if (res.status === 401 && onRefresh) {
            let newToken;
            try {
                newToken = await onRefresh(currentToken);
            }
            catch (e) {
                // A CliError from the refresh callback is a deliberate, fully-mapped
                // diagnostic (e.g. the endpoint-mismatch error, fb#465) — let it
                // through with its own hint instead of re-wrapping it below.
                if (e instanceof CliError)
                    throw e;
                const detail = errorMessage(e);
                // A FAILED refresh means the stored token is fully expired/invalid —
                // `ib auth refresh` can't recover it (it 401s the same way), so the
                // generic 401 remedy ("run ib auth refresh") is a dead end. Carry an
                // explicit hint that overrides it and sends the caller straight to
                // `ib auth login` (feedback #195).
                throw new CliError(detail, 401, null, 2, "session refresh failed — the stored token is expired/invalid and cannot be refreshed; run `ib auth login` to re-authenticate");
            }
            currentToken = newToken;
            res = await fetchOrNetworkError(method, path, payload, opts);
        }
        // Per-invocation timing for the global --stats flag (best-effort; never
        // alters the result). Records the round-trip incl. any refresh retry, plus
        // the backend's Server-Timing SQL metric when present.
        if (statsEnabled()) {
            recordRequest({ apiMs: Date.now() - startedAt, serverTiming: res.headers.get("Server-Timing") });
        }
        // Reset per response, so a later uncapped read cannot inherit an earlier
        // page's truncation flag.
        lastListMeta = res.headers.get("X-Result-Truncated") === "1"
            ? {
                truncated: true,
                limit: Number(res.headers.get("X-Result-Limit")) || undefined,
                maxLimit: Number(res.headers.get("X-Result-Limit-Max")) || undefined,
            }
            : null;
        const contentType = res.headers.get("content-type") || "";
        // Guard the body parse: a non-OK response can carry an empty or malformed
        // body even with a JSON content-type — don't let a SyntaxError escape the
        // CliError mapping below.
        const parsed = contentType.includes("application/json")
            ? await res.json().catch(() => null)
            : await res.text().catch(() => "");
        if (!res.ok) {
            if (verbose) {
                // stderr only — the stdout JSON contract is never polluted. The raw
                // body surfaces backend fields the compact envelope drops (`message`,
                // `retryable`, dev-mode `details`); the request-id links to Sentry.
                const rawBody = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
                warnNote(`[ib] HTTP ${res.status} ${method} ${endpoint}${path} · request-id ${lastRequestId}` +
                    (rawBody && rawBody !== "null" ? ` · body ${rawBody}` : ""));
            }
            throw new CliError(errorMessageFromBody(parsed, res.status, contentType), res.status, parsed, exitCodeFromStatus(res.status));
        }
        // Dry-run post-condition. EVERY handler that honours `X-Dry-Run` answers with
        // a top-level `dryRun: true` — via `middleware/dryRun.js` `respond()` or the
        // hand-built equivalents — and `sendSuccess` sends that body unwrapped. So a
        // 2xx with no marker means the route has NO dry-run guard and the write just
        // PERSISTED, which is exactly the failure `--dry-run` exists to prevent
        // (four routes shipped that way: weather toggle, keikka tila/set, sijainti
        // delete/undelete). The request is already sent, so this cannot prevent the
        // first write — it converts a silent, undetectable persist into a loud exit 6.
        // Scope is right by construction: client-side previews never reach `request`.
        if (method !== "GET" && opts.headers?.["X-Dry-Run"] === "1") {
            const marked = !!parsed &&
                typeof parsed === "object" &&
                parsed.dryRun === true;
            if (!marked) {
                throw new CliError(`Dry-run NOT honoured: '${method} ${path}' returned no dryRun marker — the write may have PERSISTED.`, 0, { code: "DRY_RUN_NOT_HONOURED" }, 6, "this endpoint has no server-side X-Dry-Run guard (or the backend predates it) — verify the effect, check the deployed build with `ib version`, and file `ib dev feedback create --kind bug`");
            }
        }
        return parsed;
    }
    return {
        /**
         * The base URL this client targets. Exposed so callers can mint sibling
         * clients for the same endpoint with a different (e.g. ephemeral, per-
         * company) token — used by the `person search --my-companies` fan-out.
         */
        endpoint,
        get: (path, opts) => request("GET", path, undefined, opts),
        post: (path, body, opts) => request("POST", path, body, opts),
        put: (path, body, opts) => request("PUT", path, body, opts),
        patch: (path, body, opts) => request("PATCH", path, body, opts),
        delete: (path, opts) => request("DELETE", path, undefined, opts),
        getCurrentToken: () => currentToken,
        /**
         * Truncation metadata from the LAST response, or null (fb#605).
         *
         * The list routes answer with a bare array and clamp `limit` server-side, so
         * there is nowhere in the payload to say "this page is capped". The backend
         * signals it out of band instead — the same channel `--stats` already reads
         * `Server-Timing` on. `null` means either "not capped" or "backend predates
         * the header", which is why the callers keep a client-side fallback.
         */
        getLastListMeta: () => lastListMeta,
    };
}
//# sourceMappingURL=client.js.map