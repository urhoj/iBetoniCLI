import { describe, test, expect, vi, beforeEach } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ApiClient auto-refresh on 401", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test("401 -> onRefresh -> retry succeeds; client uses rotated token", async () => {
    // First call: 401 (token expired)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Token expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    // Second call (retry): 200
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const onRefresh = vi.fn().mockResolvedValue("eyJnew");
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJold",
      version: "1.0.0",
      onRefresh,
    });

    const result = await client.get<{ ok: boolean }>("/api/something");
    expect(result).toEqual({ ok: true });

    // onRefresh was called once with the old token
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith("eyJold");

    // Two fetches: original + retry
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstAuth = mockFetch.mock.calls[0][1].headers.Authorization;
    const secondAuth = mockFetch.mock.calls[1][1].headers.Authorization;
    expect(firstAuth).toBe("Bearer eyJold");
    expect(secondAuth).toBe("Bearer eyJnew");

    // Rotated token is exposed for persistence
    expect(client.getCurrentToken()).toBe("eyJnew");
  });

  test("the retry re-sends the identical serialized body", async () => {
    // The body is JSON.stringify'd ONCE in request() and the same string is
    // handed to both fetches — the retry must be byte-identical to the original.
    mockFetch.mockResolvedValueOnce(
      new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJold",
      version: "1.0.0",
      onRefresh: vi.fn().mockResolvedValue("eyJnew"),
      quiet: true,
    });
    await client.post("/api/thing", { reason: "ä ö", nested: { n: 1 } });
    const [first, second] = mockFetch.mock.calls.map((c) => c[1]);
    expect(first.body).toBe('{"reason":"ä ö","nested":{"n":1}}');
    expect(second.body).toBe(first.body);
    expect(second.headers["Content-Type"]).toBe("application/json");
  });

  test("a GET carries no body and no Content-Type", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createApiClient({ endpoint: "https://api.example.com", token: "t", version: "1.0.0" });
    await client.get("/api/thing");
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    expect(mockFetch.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();
  });

  test("double-401 (refresh succeeds but retry still 401) throws CliError", async () => {
    // First call: 401
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Token expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    // Retry call: still 401 (refresh issued a token but it's still rejected)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Still unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );

    const onRefresh = vi.fn().mockResolvedValue("eyJnew");
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJold",
      version: "1.0.0",
      onRefresh,
    });

    await expect(client.get("/api/something")).rejects.toMatchObject({
      statusCode: 401,
      body: expect.objectContaining({ error: "Still unauthorized" }),
    });

    // onRefresh fired exactly once — no second retry attempt
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("refresh callback throwing surfaces as a CliError with exitCode 2 (auth)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Token expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const onRefresh = vi
      .fn()
      .mockRejectedValue(new Error("Refresh failed: HTTP 401"));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJold",
      version: "1.0.0",
      onRefresh,
    });

    await expect(client.get("/api/something")).rejects.toMatchObject({
      name: "CliError",
      exitCode: 2,
      // A dead-token refresh failure carries an explicit hint sending the caller
      // to `ib auth login` (not the dead-end `ib auth refresh`) — feedback #195.
      hint: expect.stringContaining("ib auth login"),
    });
    // No retry fetch was issued because refresh failed.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("a CliError thrown by the refresh callback propagates untouched (fb#465)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid Token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    // A deliberate diagnostic (e.g. the endpoint-mismatch error) carries its own
    // hint — the generic "expired/invalid, run `ib auth login`" wrap must not
    // replace it.
    const mismatch = new CliError(
      "401 from http://127.0.0.1:8080, but the stored session was minted against https://api.example.com",
      401,
      null,
      2,
      "authenticate against this endpoint with `ib auth login --endpoint http://127.0.0.1:8080`"
    );
    const client = createApiClient({
      endpoint: "http://127.0.0.1:8080",
      token: "eyJold",
      version: "1.0.0",
      onRefresh: vi.fn().mockRejectedValue(mismatch),
    });

    const err = await client.get("/api/something").catch((e) => e);
    expect(err).toBe(mismatch);
    expect((err as CliError).hint).toContain("ib auth login --endpoint");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
