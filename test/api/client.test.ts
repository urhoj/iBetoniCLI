import { describe, test, expect, vi, beforeEach } from "vitest";
import { createApiClient } from "../../src/api/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ApiClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test("GET adds Authorization + User-Agent + X-Request-ID", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJtest",
      version: "1.0.0",
    });
    await client.get("/api/something");
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.example.com/api/something");
    const init = call[1];
    expect(init.headers["Authorization"]).toBe("Bearer eyJtest");
    expect(init.headers["User-Agent"]).toMatch(/^ib-cli\/1\.0\.0/);
    expect(init.headers["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("POST sends JSON body and content-type", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await client.post("/api/x", { foo: 1 });
    const init = mockFetch.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ foo: 1 }));
  });

  test("HTTP error throws CliError with statusCode + body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Permission denied", code: "FORBIDDEN" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        }
      )
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await expect(client.get("/api/forbidden")).rejects.toMatchObject({
      statusCode: 403,
      body: expect.objectContaining({
        error: "Permission denied",
        code: "FORBIDDEN",
      }),
    });
  });

  test("network failure throws CliError with exitCode 7", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await expect(client.get("/api/x")).rejects.toMatchObject({
      name: "CliError",
      exitCode: 7,
    });
  });

  test("non-OK response with malformed JSON body still throws a CliError (not a SyntaxError)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await expect(client.get("/api/x")).rejects.toMatchObject({
      name: "CliError",
      statusCode: 500,
      exitCode: 6,
    });
  });

  test("explicit headers override", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await client.post(
      "/api/x",
      { y: 2 },
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "k1",
          "X-Action-Reason": "test",
        },
      }
    );
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers["X-Dry-Run"]).toBe("1");
    expect(init.headers["Idempotency-Key"]).toBe("k1");
    expect(init.headers["X-Action-Reason"]).toBe("test");
  });
});
