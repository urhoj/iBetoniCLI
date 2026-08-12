import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createApiClient, sanitizeHeaderValue } from "../../src/api/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

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

  test("error message is extracted from a NESTED error object (not '[object Object]')", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Too many requests", code: "RATE_LIMITED" } }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await expect(client.get("/api/x")).rejects.toMatchObject({
      name: "CliError",
      message: "Too many requests",
    });
  });

  test("error message falls back to top-level `message` when there is no `error`", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await expect(client.get("/api/x")).rejects.toMatchObject({ message: "boom" });
  });

  test("a structured error with no string field stringifies (never '[object Object]')", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "WEIRD" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    const err = await client.get("/api/x").catch((e) => e as Error);
    expect(err.message).not.toContain("[object Object]");
    expect(err.message).toContain("WEIRD");
  });

  test("network failure throws CliError with exitCode 7", async () => {
    // IB_NO_RETRY keeps this focused on the mapping (and instant) — the retry
    // behaviour itself is covered in its own suite below.
    process.env.IB_NO_RETRY = "1";
    try {
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
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.IB_NO_RETRY;
    }
  });

  // feedback #318: three geocode calls failed inside a 22s window and all three
  // succeeded on an immediate re-run, silently punching holes in a batch that
  // read as "no result" rather than "never evaluated".
  describe("transient network retry (feedback #318)", () => {
    const client = () =>
      createApiClient({
        endpoint: "https://api.example.com",
        token: "x",
        version: "1.0.0",
        quiet: true, // suppress the stderr retry diagnostic in tests
      });

    test("a GET that fails once then succeeds resolves, without surfacing the flap", async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      await expect(client().get("/api/x")).resolves.toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("a GET failing every attempt exits 7 and reports the attempt count", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const err = await client().get("/api/x").catch((e) => e as Error);
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(err.message).toContain("after 3 attempts");
    });

    // The safety boundary: a rejected fetch cannot distinguish "never sent"
    // from "processed, reply lost", so a mutation must never be auto-replayed.
    test("a POST is NOT retried — one attempt, then exit 7", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      await expect(client().post("/api/x", { a: 1 })).rejects.toMatchObject({ exitCode: 7 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("a read-over-POST (opts.read) IS retried — it is idempotent", async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse({ rows: [] }));
      await expect(client().post("/api/search", { q: "x" }, { read: true })).resolves.toEqual({
        rows: [],
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("IB_NO_RETRY=1 disables retry for deterministic CI runs", async () => {
      process.env.IB_NO_RETRY = "1";
      try {
        mockFetch.mockRejectedValue(new TypeError("fetch failed"));
        await expect(client().get("/api/x")).rejects.toMatchObject({ exitCode: 7 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.IB_NO_RETRY;
      }
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
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain("asiakasId 8 (Kalle Urho Oy)");
      // feedback #118: the line names the token's AUTH/company lens, so it is
      // framed "acting as" — not a "→ target" arrow, which read as a write
      // destination and masked cross-tenant --asiakas writes.
      expect(line).toContain("acting as");
      expect(line).not.toContain("→");
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
    // Body carries the dryRun marker only because the sample headers include
    // `X-Dry-Run: 1`: the client asserts that post-condition (see the "dry-run
    // post-condition" describe). This test is about header pass-through.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ dryRun: true }), {
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

  test("sanitizes non-Latin-1 header values so fetch can't throw a ByteString error", async () => {
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
    });
    await client.post("/api/x", { a: 1 }, { headers: { "X-Action-Reason": "poisto — em dash, 5 €, “lainaus”" } });
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers["X-Action-Reason"]).toBe('poisto - em dash, 5 EUR, "lainaus"');
  });
});

describe("sanitizeHeaderValue", () => {
  test("passes ASCII and Latin-1 (incl. Finnish ä/ö/å) through unchanged", () => {
    expect(sanitizeHeaderValue("plain reason 14 vrk")).toBe("plain reason 14 vrk");
    expect(sanitizeHeaderValue("ääkköset ÅÄÖ åäö")).toBe("ääkköset ÅÄÖ åäö");
  });

  test("transliterates common Unicode punctuation to ASCII", () => {
    expect(sanitizeHeaderValue("a — b")).toBe("a - b"); // em dash
    expect(sanitizeHeaderValue("a – b")).toBe("a - b"); // en dash
    expect(sanitizeHeaderValue("it’s")).toBe("it's"); // curly apostrophe
    expect(sanitizeHeaderValue("“q”")).toBe('"q"'); // curly quotes
    expect(sanitizeHeaderValue("wait…")).toBe("wait..."); // ellipsis
    expect(sanitizeHeaderValue("5 €")).toBe("5 EUR"); // euro
  });

  test("replaces any remaining >255 code point with '?'", () => {
    expect(sanitizeHeaderValue("emoji 😀 x")).toBe("emoji ?? x"); // astral → 2 surrogate units
  });

  test("neutralizes control chars (CR/LF) to block header injection", () => {
    expect(sanitizeHeaderValue("ok\r\nX-Evil: 1")).toBe("ok??X-Evil: 1");
  });
});

describe("dry-run post-condition", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const client = () =>
    createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJtest",
      version: "1.0.0",
    });

  const dryRunHeaders = { headers: { "X-Dry-Run": "1" } };

  test("passes through when the response carries the dryRun marker", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ dryRun: true, wouldUpdate: { id: 1 }, validation: { ok: true } })
    );
    const res = await client().post("/api/thing", { a: 1 }, dryRunHeaders);
    expect(res).toMatchObject({ dryRun: true });
  });

  test("throws exit 6 DRY_RUN_NOT_HONOURED when the marker is absent", async () => {
    // The exact shape the four unguarded routes returned: a normal success body.
    mockFetch.mockResolvedValueOnce(jsonResponse({ enabled: false, asiakasId: 26, success: true }));
    await expect(client().post("/api/thing", { a: 1 }, dryRunHeaders)).rejects.toMatchObject({
      exitCode: 6,
      statusCode: 0,
      body: { code: "DRY_RUN_NOT_HONOURED" },
    });
  });

  test("does not fire without the X-Dry-Run header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    await expect(client().post("/api/thing", { a: 1 })).resolves.toMatchObject({ success: true });
  });

  test("does not fire on a GET", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    await expect(client().get("/api/thing", dryRunHeaders)).resolves.toMatchObject({ rows: [] });
  });

  test("a real HTTP error still surfaces as itself, not as a missing marker", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 403));
    await expect(client().post("/api/thing", { a: 1 }, dryRunHeaders)).rejects.toMatchObject({
      statusCode: 403,
      exitCode: 3,
    });
  });

  test("dryRun:false in the body is treated as not honoured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ dryRun: false, success: true }));
    await expect(client().post("/api/thing", { a: 1 }, dryRunHeaders)).rejects.toMatchObject({
      exitCode: 6,
    });
  });
});

// --verbose failure diagnostic (feedback #444: the flag was parsed but consumed
// NOWHERE, so every "retry with --verbose" remedy promised detail that could
// not appear). It must surface what the compact envelope drops: the raw body
// and the X-Request-ID actually sent (Sentry correlation).
describe("verbose failure diagnostic", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockFetch.mockReset();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const client = (verbose: boolean) =>
    createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJtest",
      version: "1.0.0",
      requestId: "req-fixed-id",
      verbose,
    });

  test("prints method, URL, status, request-id, and the raw body on a failed request", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        { success: false, error: "DATABASE_ERROR", message: "Tietokantavirhe.", retryable: false },
        500
      )
    );
    await expect(client(true).post("/api/legal-documents/save", { a: 1 })).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0][0] as string;
    expect(line).toContain("HTTP 500 POST https://api.example.com/api/legal-documents/save");
    expect(line).toContain("request-id req-fixed-id");
    // The raw body carries fields the compact error envelope drops.
    expect(line).toContain('"message":"Tietokantavirhe."');
    expect(line).toContain('"retryable":false');
  });

  test("silent without verbose", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 500));
    await expect(client(false).get("/api/thing")).rejects.toMatchObject({ statusCode: 500 });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("silent on a successful request even with verbose", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(client(true).get("/api/thing")).resolves.toMatchObject({ ok: true });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
