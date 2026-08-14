/**
 * Recognise and summarise an HTML error body (fb#577).
 *
 * A LEAF module that imports nothing, for the same reason `output/nearest.ts`
 * is one: its two consumers sit on opposite sides of a real import cycle.
 * `client.ts` already imports `errors.ts` (CliError, exitCodeFromStatus), so
 * `errors.ts` cannot import back from `client.ts` to reuse these.
 *
 * WHY THIS EXISTS AT ALL. Cloudflare replaces an origin 5xx with its own
 * generic 502 and DISCARDS the JSON body, and serves the same interstitial when
 * the origin is briefly unreachable. So a CF 502 usually means "the request
 * never reached puminet5api", not "puminet5api errored" — while the raw page
 * lands in the envelope's `error` string, which is the CLI's machine-readable
 * channel and whose primary consumer is an AI.
 */
/**
 * True when an error body is an HTML page rather than the API's JSON envelope.
 *
 * Sniffs the BODY as well as the content-type: the interstitial is what it is
 * regardless of the header, and an edge that sends `text/html` with an empty
 * body should still fall through to the plain `HTTP <status>`.
 */
export function looksLikeHtml(body, contentType = "") {
    if (typeof body !== "string" || !body)
        return false;
    return contentType.includes("text/html") || /^\s*<(?:!doctype|html)\b/i.test(body);
}
/**
 * Collapse an HTML error page to ONE line: its <title>, tagged with provenance.
 *
 * The provenance half is the load-bearing part. Without it the caller reads a
 * bare "502 Bad Gateway" as an application fault and goes debugging a service
 * that was never involved — `ib version` then reports the app healthy, which
 * reads as a mystery rather than as the answer.
 */
export function summarizeHtmlErrorBody(html, status) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
    return `${title || `HTTP ${status}`} (HTML response from an edge proxy, not the application)`;
}
//# sourceMappingURL=htmlErrorBody.js.map