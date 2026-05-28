import { describe, test, expect, vi, beforeEach } from "vitest";
import { refreshToken } from "../../src/auth/refresh.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("refreshToken", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test("200 response returns the new JWT and POSTs with Bearer header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: "eyJnew", message: "Token refreshed successfully" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const newJwt = await refreshToken({
      endpoint: "https://api.example.com",
      currentJwt: "eyJold",
    });
    expect(newJwt).toBe("eyJnew");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/auth/refresh-token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer eyJold");
  });

  test("non-200 response throws", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Could not refresh token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(
      refreshToken({ endpoint: "https://api.example.com", currentJwt: "eyJold" })
    ).rejects.toThrow(/Refresh failed: HTTP 401/);
  });
});
