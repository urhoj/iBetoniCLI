import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Capture process.stderr writes — `--print-payload` must never touch stdout. */
function captureStderr(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  return { lines: () => written, restore: () => spy.mockRestore() };
}

/** The one `[ib] payload · {…}` line, parsed back into an object. */
function parsePayloadLine(lines: string[]): Record<string, unknown> {
  const line = lines.find((l) => l.includes("[ib] payload · "));
  expect(line, "expected a payload diagnostic line on stderr").toBeDefined();
  return JSON.parse(line!.slice(line!.indexOf("· ") + 2)) as Record<string, unknown>;
}

// fb#636 — "did my flag parse into the body I intended?" had no answer through
// `ib`: server --dry-run is deploy-gated and can still persist, and --read-only
// refuses naming only the method and path while the assembled body is discarded
// unseen. Verifying fb#634 required re-declaring the command's options in a
// standalone Commander harness, which proves something about the harness.
describe("--print-payload (fb#636)", () => {
  let err: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    mockFetch.mockReset();
    err = captureStderr();
  });
  afterEach(() => err.restore());

  test("emits the RESOLVED method, path and body before sending", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJtest",
      version: "1.0.0",
      printPayload: true,
    });
    await client.put("/api/jerry-provider-settings", { email: "", asiakasId: 1380 });

    const payload = parsePayloadLine(err.lines());
    expect(payload.method).toBe("PUT");
    expect(payload.path).toBe("/api/jerry-provider-settings");
    // The whole point: an EMPTY string must be visibly present, not absent.
    // `--email=` resolving to "" vs being dropped is the fb#634 question.
    expect(payload.body).toEqual({ email: "", asiakasId: 1380 });
  });

  test("redacts the bearer token — this line gets pasted into bug reports", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "eyJsuperuser.secret.jwt",
      version: "1.0.0",
      printPayload: true,
    });
    await client.post("/api/x", { a: 1 });

    const raw = err.lines().join("");
    expect(raw).not.toContain("eyJsuperuser.secret.jwt");
    const headers = parsePayloadLine(err.lines()).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ***");
  });

  test("does not print a request id that differs from the one actually sent", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      printPayload: true,
    });
    await client.post("/api/x", { a: 1 });

    const headers = parsePayloadLine(err.lines()).headers as Record<string, string>;
    const sent = mockFetch.mock.calls[0][1].headers["X-Request-ID"];
    // A fresh UUID is minted per attempt, so any concrete value here would be a
    // plausible-but-wrong correlation id — worse than none.
    expect(headers["X-Request-ID"]).toBe("<minted per attempt>");
    expect(headers["X-Request-ID"]).not.toBe(sent);
  });

  test("prints the pinned request id verbatim when --request-id was given", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      requestId: "pinned-123",
      printPayload: true,
    });
    await client.post("/api/x", { a: 1 });

    const headers = parsePayloadLine(err.lines()).headers as Record<string, string>;
    expect(headers["X-Request-ID"]).toBe("pinned-123");
  });

  test("carries the write-safety headers a --reason/--dry-run resolved into", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      printPayload: true,
    });
    await client.post("/api/x", { a: 1 }, { headers: { "X-Action-Reason": "fb#636 probe" } });

    const headers = parsePayloadLine(err.lines()).headers as Record<string, string>;
    expect(headers["X-Action-Reason"]).toBe("fb#636 probe");
  });

  test("with --read-only: SHOWS the write, then refuses it — nothing is sent", async () => {
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      readOnly: true,
      printPayload: true,
    });
    await expect(client.put("/api/x", { email: "" })).rejects.toBeInstanceOf(CliError);

    // The body was visible even though the request never left the process —
    // exactly the gap fb#636 filed (the refusal named only method + path).
    const payload = parsePayloadLine(err.lines());
    expect(payload.body).toEqual({ email: "" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("emits and CONTINUES: the real response is still returned", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ saved: true, id: 7 }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      printPayload: true,
    });
    // A print-and-abort design would hand run* functions a stub to project.
    await expect(client.post("/api/x", { a: 1 })).resolves.toEqual({ saved: true, id: 7 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("covers GETs too — the read half of a read-merge-write is where fields vanish", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ vehicleId: 5 }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      printPayload: true,
    });
    await client.get("/api/vehicle/5");

    const payload = parsePayloadLine(err.lines());
    expect(payload.method).toBe("GET");
    expect(payload.path).toBe("/api/vehicle/5");
    expect(payload).not.toHaveProperty("body");
  });

  test("off by default: no diagnostic, and the request is unchanged", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
    });
    await client.post("/api/x", { a: 1 });

    expect(err.lines().join("")).not.toContain("[ib] payload");
    expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify({ a: 1 }));
  });

  test("a previewed-then-refused request leaves no request id behind for --verbose", async () => {
    // buildHeaders writes lastRequestId as a side effect; the preview snapshots
    // and restores it, so a refused write cannot leave an id that was never sent.
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 500));
    const client = createApiClient({
      endpoint: "https://api.example.com",
      token: "x",
      version: "1.0.0",
      requestId: "pinned-abc",
      printPayload: true,
      verbose: true,
    });
    await expect(client.get("/api/x")).rejects.toBeInstanceOf(CliError);
    const raw = err.lines().join("");
    expect(raw).toContain("pinned-abc");
  });
});
