import { describe, test, expect, vi } from "vitest";
import {
  runPersonSearchMyCompanies,
  runPersonSearchMyCompaniesFanout,
  runPersonSearchAllCompanies,
} from "../../src/commands/person/index.js";
import { CliError } from "../../src/api/errors.js";
import type { ApiClient } from "../../src/api/client.js";

describe("runPersonSearchMyCompaniesFanout (client-side fallback)", () => {
  test("searches every company and tags each hit with its company (authoritative)", async () => {
    const listCompanies = vi.fn().mockResolvedValue([
      { asiakasId: 8, name: "Kalle Urho Oy" },
      { asiakasId: 26, name: "PumiNet Oy" },
    ]);
    const searchIn = vi.fn(async (asiakasId: number) =>
      asiakasId === 8
        ? {
            items: [
              {
                personId: 100,
                name: "Mikko Ikonen",
                email: "mikko@x.fi",
                phone: "040",
                asiakasId: 8,
              },
            ],
            nextCursor: null,
            count: 1,
          }
        : { items: [], nextCursor: null, count: 0 }
    );

    const res = await runPersonSearchMyCompaniesFanout(listCompanies, searchIn);

    expect(searchIn).toHaveBeenCalledWith(8);
    expect(searchIn).toHaveBeenCalledWith(26);
    expect(res.count).toBe(1);
    expect(res.items[0]).toEqual({
      personId: 100,
      name: "Mikko Ikonen",
      email: "mikko@x.fi",
      phone: "040",
      asiakasId: 8,
      asiakasName: "Kalle Urho Oy",
    });
  });

  test("merges hits across companies and overrides asiakasId/name from the company", async () => {
    const listCompanies = vi.fn().mockResolvedValue([
      { asiakasId: 8, name: "A" },
      { asiakasId: 26, name: "B" },
    ]);
    const searchIn = vi.fn(async (asiakasId: number) => ({
      items: [
        {
          personId: asiakasId * 10,
          name: "X Y",
          email: null,
          phone: null,
          asiakasId: 999,
        },
      ],
      nextCursor: null,
      count: 1,
    }));

    const res = await runPersonSearchMyCompaniesFanout(listCompanies, searchIn);

    expect(res.count).toBe(2);
    expect(res.items.map((i) => i.asiakasId)).toEqual([8, 26]);
    expect(res.items.map((i) => i.asiakasName)).toEqual(["A", "B"]);
    expect(res.nextCursor).toBeNull();
  });
});

describe("runPersonSearchMyCompanies (server endpoint + graceful fallback)", () => {
  const mkClient = (get: ReturnType<typeof vi.fn>): ApiClient =>
    ({
      get,
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getCurrentToken: vi.fn(),
      endpoint: "https://api.example.com",
    }) as unknown as ApiClient;

  const envelope = {
    items: [
      {
        personId: 1,
        name: "A B",
        email: null,
        phone: null,
        asiakasId: 8,
        asiakasName: "X",
      },
    ],
    nextCursor: null,
    count: 1,
  };

  test("calls GET /api/cli/person/search and returns its envelope (no fallback)", async () => {
    const get = vi.fn().mockResolvedValue(envelope);
    const fallback = vi.fn();
    const res = await runPersonSearchMyCompanies(mkClient(get), "A", {
      limit: 50,
      fallback,
    });
    expect(get).toHaveBeenCalledWith("/api/cli/person/search?q=A&limit=50");
    expect(res).toBe(envelope);
    expect(fallback).not.toHaveBeenCalled();
  });

  test("falls back to the client fan-out on a 404 (endpoint not deployed yet)", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("not found", 404, null, 5));
    const fallbackEnv = { items: [], nextCursor: null, count: 0 };
    const fallback = vi.fn().mockResolvedValue(fallbackEnv);
    const res = await runPersonSearchMyCompanies(mkClient(get), "A", { fallback });
    expect(fallback).toHaveBeenCalledOnce();
    expect(res).toBe(fallbackEnv);
  });

  test("propagates a non-404 error (does not fall back)", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("boom", 500, null, 6));
    const fallback = vi.fn();
    await expect(
      runPersonSearchMyCompanies(mkClient(get), "A", { fallback })
    ).rejects.toBeInstanceOf(CliError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

// feedback #310: the true global sweep. Unlike --my-companies it has NO
// client-side fallback — a global result cannot be synthesized from the caller's
// own memberships, and a silently narrower list would read as complete.
describe("runPersonSearchAllCompanies (--all-companies)", () => {
  const mkClient = (get: ReturnType<typeof vi.fn>) =>
    ({ get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn() }) as unknown as ApiClient;

  const envelope = {
    items: [
      {
        personId: 6233,
        name: "Betoni Jerry",
        email: "betoni.jerry@ibetoni.fi",
        phone: null,
        asiakasId: 1349,
        asiakasName: "BetoniJerry",
      },
    ],
    nextCursor: null,
    count: 1,
    truncated: false,
  };

  test("calls GET /api/cli/person/search/global with q + limit", async () => {
    const get = vi.fn().mockResolvedValue(envelope);
    const res = await runPersonSearchAllCompanies(mkClient(get), "Jerry", 100);
    expect(get).toHaveBeenCalledWith("/api/cli/person/search/global?q=Jerry&limit=100");
    expect(res).toBe(envelope);
  });

  test("omits limit from the query when unset", async () => {
    const get = vi.fn().mockResolvedValue(envelope);
    await runPersonSearchAllCompanies(mkClient(get), "Jerry");
    expect(get).toHaveBeenCalledWith("/api/cli/person/search/global?q=Jerry");
  });

  test("propagates a 404 instead of degrading to a narrower scope", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("not found", 404, null, 5));
    await expect(
      runPersonSearchAllCompanies(mkClient(get), "Jerry")
    ).rejects.toBeInstanceOf(CliError);
  });

  test("propagates the 403 a non-developer gets", async () => {
    const get = vi.fn().mockRejectedValue(new CliError("forbidden", 403, null, 3));
    await expect(
      runPersonSearchAllCompanies(mkClient(get), "Jerry")
    ).rejects.toMatchObject({ statusCode: 403, exitCode: 3 });
  });
});
