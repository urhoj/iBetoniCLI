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
});
