import { describe, test, expect, vi, beforeEach } from "vitest";
import { createApiClient } from "../../src/api/client.js";

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
    });
    // No retry fetch was issued because refresh failed.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
