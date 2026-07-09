import { describe, test, expect, vi } from "vitest";
import type { ApiClient } from "../../../src/api/client.js";
import {
  runImpersonationSessions,
  runImpersonationGrants,
} from "../../../src/commands/dev/impersonation/index.js";

function mockClient(getImpl: (path: string) => unknown): ApiClient {
  return {
    get: vi.fn(async (path: string) => getImpl(path)),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(() => "tok"),
  } as unknown as ApiClient;
}

describe("runImpersonationSessions", () => {
  test("no filters → bare path, projects backend shape into a ListEnvelope", async () => {
    const backend = {
      items: [{ sessionId: "s1", actorPersonId: 10, targetPersonId: 63, active: false, endReason: "logout" }],
      count: 1,
      truncated: false,
    };
    const client = mockClient(() => backend);
    const res = await runImpersonationSessions(client, {});
    expect(client.get).toHaveBeenCalledWith("/api/cli/impersonation-sessions");
    expect(res).toEqual({ items: backend.items, nextCursor: null, count: 1, truncated: false });
  });

  test("all filters → querystring in declared order", async () => {
    const client = mockClient(() => ({ items: [], count: 0, truncated: false }));
    await runImpersonationSessions(client, {
      actor: 10,
      target: 63,
      endReason: "logout",
      active: true,
      limit: 25,
    });
    expect(client.get).toHaveBeenCalledWith(
      "/api/cli/impersonation-sessions?actor=10&target=63&endReason=logout&active=true&limit=25"
    );
  });

  test("single filter → only that param", async () => {
    const client = mockClient(() => ({ items: [], count: 0, truncated: false }));
    await runImpersonationSessions(client, { endReason: "timeout" });
    expect(client.get).toHaveBeenCalledWith(
      "/api/cli/impersonation-sessions?endReason=timeout"
    );
  });

  test("tolerates a backend payload missing count/truncated", async () => {
    const client = mockClient(() => ({ items: [{ sessionId: "x" }] }));
    const res = await runImpersonationSessions(client, {});
    expect(res).toEqual({ items: [{ sessionId: "x" }], nextCursor: null, count: 1, truncated: false });
  });
});

describe("runImpersonationGrants", () => {
  test("GETs the per-person grants route", async () => {
    const backend = { outbound: [], inbound: [] };
    const client = mockClient(() => backend);
    const res = await runImpersonationGrants(client, 63);
    expect(client.get).toHaveBeenCalledWith("/api/persons/63/impersonation-grants");
    expect(res).toBe(backend);
  });
});
