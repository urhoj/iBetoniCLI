import { describe, test, expect } from "vitest";
import { startCallbackServer } from "../../src/auth/callbackServer";

describe("OAuth callback HTTP listener", () => {
  test("binds 127.0.0.1 with random port and resolves on /callback", async () => {
    const server = await startCallbackServer({ timeoutMs: 5000, expectedState: "abc123" });
    const port = server.port;
    expect(port).toBeGreaterThan(0);

    const codePromise = server.waitForCode();

    const res = await fetch(`http://127.0.0.1:${port}/callback?code=test_code&state=abc123`);
    expect(res.status).toBe(200);

    const { code, state } = await codePromise;
    expect(code).toBe("test_code");
    expect(state).toBe("abc123");

    server.close();
  });

  test("rejects mismatched state with HTTP 400", async () => {
    const server = await startCallbackServer({ timeoutMs: 5000, expectedState: "expected" });
    const port = server.port;
    const codePromise = server.waitForCode();

    const res = await fetch(`http://127.0.0.1:${port}/callback?code=test&state=different`);
    expect(res.status).toBe(400);

    await expect(codePromise).rejects.toThrow(/state mismatch/i);
    server.close();
  });

  test("times out if no callback arrives", async () => {
    const server = await startCallbackServer({ timeoutMs: 100, expectedState: "x" });
    await expect(server.waitForCode()).rejects.toThrow(/timeout/i);
    server.close();
  });

  test("success response renders the branded Finnish page with a manual-close hint", async () => {
    const server = await startCallbackServer({ timeoutMs: 5000, expectedState: "abc" });
    const codePromise = server.waitForCode();
    const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=xyz&state=abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Kirjautuminen onnistui");
    expect(body).toContain("iBetoni CLI");
    // Tells the user to close the tab manually; no auto-close promise or script
    // (browsers block window.close() for tabs the script did not open).
    expect(body).toContain("Voit sulkea tämän välilehden");
    expect(body).not.toContain("window.close");
    expect(body).not.toContain("automaattisesti");
    await codePromise;
    server.close();
  });

  test("error responses render the branded Finnish error page", async () => {
    // state mismatch
    const s1 = await startCallbackServer({ timeoutMs: 5000, expectedState: "abc" });
    const p1 = s1.waitForCode();
    const r1 = await fetch(`http://127.0.0.1:${s1.port}/callback?code=xyz&state=nope`);
    expect(r1.status).toBe(400);
    expect(r1.headers.get("content-type")).toContain("text/html");
    expect(await r1.text()).toContain("Kirjautuminen epäonnistui");
    await expect(p1).rejects.toThrow(/state mismatch/i);
    s1.close();

    // missing code/state
    const s2 = await startCallbackServer({ timeoutMs: 5000, expectedState: "abc" });
    const p2 = s2.waitForCode();
    const r2 = await fetch(`http://127.0.0.1:${s2.port}/callback?state=abc`);
    expect(r2.status).toBe(400);
    expect(r2.headers.get("content-type")).toContain("text/html");
    expect(await r2.text()).toContain("Kirjautuminen epäonnistui");
    await expect(p2).rejects.toThrow(/missing code or state/i);
    s2.close();
  });
});
