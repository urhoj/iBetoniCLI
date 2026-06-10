import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
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

  test("exposes its endpoint so callers can build sibling clients", () => {
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    expect(client.endpoint).toBe("https://api.example.com");
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

  test("readOnly refuses POST/PUT/DELETE before any fetch (exit 3)", async () => {
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      readOnly: true,
    });
    for (const call of [
      () => client.post("/api/x", { a: 1 }),
      () => client.put("/api/x", { a: 1 }),
      () => client.delete("/api/x"),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: "CliError",
        exitCode: 3,
        body: { code: "READ_ONLY_BLOCKED" },
      });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("readOnly still allows GET", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      readOnly: true,
    });
    await expect(client.get("/api/x")).resolves.toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe("actingAs write diagnostic", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    function okResponse() {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }

    test("prints the target company once on the first write, not on GET", async () => {
      okResponse();
      const client = createApiClient({
        endpoint: "https://api.example.com",
        token: "x",
        version: "1.0.0",
        actingAs: { ownerAsiakasId: 8, ownerAsiakasName: "Kalle Urho Oy" },
      });
      await client.get("/api/read"); // no announce on read
      expect(stderrSpy).not.toHaveBeenCalled();
      await client.post("/api/x", { a: 1 });
      await client.post("/api/y", { a: 2 }); // second write: no repeat
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0]).toContain("asiakasId 8 (Kalle Urho Oy)");
    });

    test("flags the BetoniJerry umbrella tenant", async () => {
      okResponse();
      const client = createApiClient({
        endpoint: "https://api.example.com",
        token: "x",
        version: "1.0.0",
        actingAs: { ownerAsiakasId: 1349, ownerAsiakasName: "BetoniJerry" },
      });
      await client.post("/api/x", { a: 1 });
      expect(stderrSpy.mock.calls[0][0]).toContain("BetoniJerry umbrella tenant");
    });

    test("quiet suppresses the diagnostic", async () => {
      okResponse();
      const client = createApiClient({
        endpoint: "https://api.example.com",
        token: "x",
        version: "1.0.0",
        actingAs: { ownerAsiakasId: 8 },
        quiet: true,
      });
      await client.post("/api/x", { a: 1 });
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    test("read-only refusal does not announce (no write happened)", async () => {
      const client = createApiClient({
        endpoint: "https://api.example.com",
        token: "x",
        version: "1.0.0",
        actingAs: { ownerAsiakasId: 8 },
        readOnly: true,
      });
      await expect(client.post("/api/x", { a: 1 })).rejects.toMatchObject({
        exitCode: 3,
      });
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  test("readOnly ALLOWS a POST marked { read: true } (it is a tenant read)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      readOnly: true,
    });
    await client.post("/api/person/search", { searchString: "x" }, { read: true });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  test("a { read: true } POST does NOT print the acting-as write line", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      actingAs: { ownerAsiakasId: 26, ownerAsiakasName: "PumiNet Oy" },
    });
    await client.post("/api/person/search", { searchString: "x" }, { read: true });
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
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
