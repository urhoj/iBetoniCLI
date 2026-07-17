import { describe, test, expect, vi, afterEach } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { setAmbientCommandPath } from "../../src/commandContext.js";

afterEach(() => {
  setAmbientCommandPath(null);
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const client = () =>
  createApiClient({ endpoint: "http://x", token: "t", version: "0.0.0", requestId: "rid", quiet: true });

describe("X-Ib-Command header", () => {
  test("attached when the ambient command path is set", async () => {
    const fetchMock = stubFetch();
    setAmbientCommandPath("dev feedback get");
    await client().get("/api/anything");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Ib-Command"]).toBe("dev feedback get");
  });

  test("absent when no ambient command path is set", async () => {
    const fetchMock = stubFetch();
    await client().get("/api/anything");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Ib-Command"]).toBeUndefined();
  });
});
