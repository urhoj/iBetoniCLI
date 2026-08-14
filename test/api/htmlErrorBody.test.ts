import { describe, test, expect } from "vitest";
import { looksLikeHtml, summarizeHtmlErrorBody } from "../../src/api/htmlErrorBody.js";
import { CliError, hintForError } from "../../src/api/errors.js";

/**
 * fb#577. A plain read (`ib dev feedback get 551`) exited 6 carrying the whole
 * Cloudflare interstitial as its message, plus the generic "backend error —
 * retry with --verbose; file a bug" hint. An immediate re-run of the identical
 * command succeeded: it was a transient edge blip that never reached the
 * application, so the hint pointed at a service that was never involved.
 */
const CF_502 =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>cloudflare</center>\r\n</body>\r\n</html>\r\n";

describe("looksLikeHtml", () => {
  test("recognises an edge interstitial by its body, with no content-type at all", () => {
    expect(looksLikeHtml(CF_502)).toBe(true);
    expect(looksLikeHtml("  <!DOCTYPE html><html>…")).toBe(true);
  });

  test("recognises it by content-type even when the body is not sniffable", () => {
    expect(looksLikeHtml("error occurred", "text/html; charset=utf-8")).toBe(true);
  });

  test("a JSON envelope or a plain-text body is NOT html", () => {
    // The API's own error shape must keep flowing through untouched.
    expect(looksLikeHtml('{"error":"Not found"}', "application/json")).toBe(false);
    expect(looksLikeHtml("Not found")).toBe(false);
  });

  test("a non-string body is never html — guards the JSON-object path", () => {
    expect(looksLikeHtml({ error: "x" })).toBe(false);
    expect(looksLikeHtml(null)).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
  });

  test("an html content-type with an EMPTY body does not qualify", () => {
    // Nothing to summarize — better to fall through to `HTTP <status>` than to
    // emit a provenance tag with no title behind it.
    expect(looksLikeHtml("", "text/html")).toBe(false);
  });
});

describe("summarizeHtmlErrorBody", () => {
  test("collapses ~130 chars of interstitial to one line carrying the provenance", () => {
    expect(summarizeHtmlErrorBody(CF_502, 502)).toBe(
      "502 Bad Gateway (HTML response from an edge proxy, not the application)"
    );
  });

  test("normalizes whitespace inside a multi-line title", () => {
    const html = "<html><head><title>504\n  Gateway   Timeout</title></head></html>";
    expect(summarizeHtmlErrorBody(html, 504)).toBe(
      "504 Gateway Timeout (HTML response from an edge proxy, not the application)"
    );
  });

  test("falls back to the status when the page has no title", () => {
    expect(summarizeHtmlErrorBody("<html><body>nope</body></html>", 503)).toBe(
      "HTTP 503 (HTML response from an edge proxy, not the application)"
    );
  });

  /** A CF challenge page or a 5xx carrying a ray id is far bigger than the 502. */
  test("a large page still collapses to one line", () => {
    const big = `<html><head><title>Attention Required! | Cloudflare</title></head><body>${"x".repeat(5000)}</body></html>`;
    const out = summarizeHtmlErrorBody(big, 403);
    expect(out).toBe(
      "Attention Required! | Cloudflare (HTML response from an edge proxy, not the application)"
    );
    expect(out.length).toBeLessThan(120);
  });
});

describe("hintForError — an edge 5xx is not an application fault (fb#577)", () => {
  test("a 5xx with an HTML body gets the edge remedy, not 'file a backend bug'", () => {
    const err = new CliError("502 Bad Gateway (HTML response from an edge proxy, not the application)", 502, CF_502, 6);
    const hint = hintForError(err, null);
    expect(hint).toMatch(/came from the EDGE/);
    expect(hint).toMatch(/never reached the backend/);
    expect(hint).toMatch(/ib version/);
    // The wrong advice must be GONE, not merely accompanied.
    expect(hint).not.toMatch(/file `ib dev feedback create/);
  });

  test("a 5xx from the application itself keeps the original remedy", () => {
    const err = new CliError("Internal server error", 500, { error: "boom" }, 6);
    expect(hintForError(err, null)).toMatch(/backend error — retry with --verbose/);
  });

  test("a 4xx with an HTML body is untouched — this is a 5xx-only reading", () => {
    // 401/403/404 have their own precise remedies; an edge that happens to
    // answer HTML there must not displace them.
    const err = new CliError("x", 403, CF_502, 3);
    expect(hintForError(err, null)).toMatch(/permission denied/);
  });
});
