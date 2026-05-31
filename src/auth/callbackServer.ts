import { createServer, type Server } from "node:http";
import { URL } from "node:url";

/**
 * Self-contained branded HTML for the local OAuth return tab.
 * Inline CSS only — this page is served from 127.0.0.1 with no asset host.
 * `ok` selects success (green) vs error (red) treatment.
 */
function renderPage(opts: { ok: boolean; title: string; body: string }): string {
  const accent = opts.ok ? "#2e9e5b" : "#d84343";
  const accent2 = opts.ok ? "#43c97a" : "#f06b6b";
  const glyph = opts.ok ? "&#10003;" : "!";
  // No programmatic close: browsers ignore window.close() for tabs the script did
  // not open (the OAuth redirect lands in an OS-opened tab), so promising auto-close
  // is a promise we can't keep — the manual "you can close this tab" hint is the truth.
  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title} · iBetoni CLI</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f4f7fa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a2027}
  .card{max-width:380px;width:90%;background:#fff;border-radius:16px;
    border:1px solid rgba(0,0,0,.08);box-shadow:0 8px 32px rgba(0,0,0,.10);overflow:hidden}
  .bar{height:4px;background:linear-gradient(90deg,${accent},${accent2})}
  .pad{padding:32px 28px;text-align:center}
  .ic{width:64px;height:64px;border-radius:50%;margin:0 auto 16px;display:flex;
    align-items:center;justify-content:center;color:#fff;font-size:32px;
    background:linear-gradient(135deg,${accent},${accent2});box-shadow:0 6px 18px ${accent}59}
  h1{font-size:1.4rem;margin:0 0 8px;
    background:linear-gradient(135deg,${accent},${accent2});-webkit-background-clip:text;
    background-clip:text;color:transparent}
  p{margin:6px 0;color:#5a6b7b;font-size:.9rem;line-height:1.5}
  .hint{font-size:.78rem;color:#90a4ae}
  code{font-family:ui-monospace,Menlo,monospace;background:#f0f3f6;padding:1px 6px;border-radius:4px}
  .brand{margin-top:18px;font-weight:700;color:#1976d2;font-size:.74rem;letter-spacing:.05em}
</style></head>
<body><div class="card"><div class="bar"></div><div class="pad">
  <div class="ic">${glyph}</div>
  <h1>${opts.title}</h1>
  ${opts.body}
  <div class="brand">betoni.online · iBetoni CLI</div>
</div></div></body></html>`;
}

export interface CallbackServerOptions {
  timeoutMs: number;
  expectedState: string;
}

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServer {
  port: number;
  waitForCode(): Promise<CallbackResult>;
  close(): void;
}

export async function startCallbackServer(opts: CallbackServerOptions): Promise<CallbackServer> {
  let resolveCode!: (r: CallbackResult) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<CallbackResult>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server: Server = createServer((req, res) => {
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
    // Render a 400 error page and reject the pending code promise.
    const fail = (body: string, message: string): void => {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderPage({ ok: false, title: "Kirjautuminen epäonnistui", body }));
      rejectCode(new Error(message));
    };

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      fail(
        "<p>Palaa terminaaliin ja yritä uudelleen komennolla <code>ib auth login</code>.</p>",
        "Missing code or state in callback"
      );
      return;
    }
    if (state !== opts.expectedState) {
      fail(
        "<p>Turvatarkistus epäonnistui. Palaa terminaaliin ja yritä uudelleen komennolla <code>ib auth login</code>.</p>",
        "OAuth callback state mismatch"
      );
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        ok: true,
        title: "Kirjautuminen onnistui",
        body: "<p>Voit sulkea tämän välilehden ja palata terminaaliin.</p>",
      })
    );
    resolveCode({ code, state });
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind callback server");
  }
  const port = address.port;

  const timeout = setTimeout(
    () => rejectCode(new Error(`OAuth callback timeout after ${opts.timeoutMs}ms`)),
    opts.timeoutMs
  );

  // Wrap once so finally(clearTimeout) runs exactly once and the wrapped
  // promise has a stable identity across multiple waitForCode() calls.
  const wrapped = codePromise.finally(() => clearTimeout(timeout));
  // Attach a no-op catch so the rejection is always "handled" — callers may
  // attach their .catch() asynchronously (e.g. via `await expect(...).rejects`),
  // which would otherwise trigger PromiseRejectionHandledWarning.
  wrapped.catch(() => {});

  return {
    port,
    waitForCode: () => wrapped,
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}
