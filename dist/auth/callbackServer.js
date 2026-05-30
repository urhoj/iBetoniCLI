import { createServer } from "node:http";
import { URL } from "node:url";
export async function startCallbackServer(opts) {
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
        resolveCode = res;
        rejectCode = rej;
    });
    const server = createServer((req, res) => {
        if (!req.url) {
            res.statusCode = 404;
            res.end();
            return;
        }
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/callback") {
            res.statusCode = 404;
            res.end();
            return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
            res.statusCode = 400;
            res.end("Missing code or state.");
            rejectCode(new Error("Missing code or state in callback"));
            return;
        }
        if (state !== opts.expectedState) {
            res.statusCode = 400;
            res.end("State mismatch — possible CSRF attempt.");
            rejectCode(new Error("OAuth callback state mismatch"));
            return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif"><h2>You're signed in.</h2><p>You can close this tab and return to your terminal.</p></body></html>`);
        resolveCode({ code, state });
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to bind callback server");
    }
    const port = address.port;
    const timeout = setTimeout(() => rejectCode(new Error(`OAuth callback timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs);
    // Wrap once so finally(clearTimeout) runs exactly once and the wrapped
    // promise has a stable identity across multiple waitForCode() calls.
    const wrapped = codePromise.finally(() => clearTimeout(timeout));
    // Attach a no-op catch so the rejection is always "handled" — callers may
    // attach their .catch() asynchronously (e.g. via `await expect(...).rejects`),
    // which would otherwise trigger PromiseRejectionHandledWarning.
    wrapped.catch(() => { });
    return {
        port,
        waitForCode: () => wrapped,
        close: () => {
            clearTimeout(timeout);
            server.close();
        },
    };
}
//# sourceMappingURL=callbackServer.js.map