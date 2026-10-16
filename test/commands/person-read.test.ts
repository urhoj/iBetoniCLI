import { describe, test, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";
import { captureActionError } from "../helpers/stderr.js";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPersonList,
  runPersonGet,
  runPersonSearch,
  registerPersonCommands,
} from "../../src/commands/person/index.js";

const mockClient = mockApiClient();

describe("ib person list/get/search", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.post.mockReset();
  });

  test("runPersonList: hits bare path when no opts set", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runPersonList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/list");
  });

  test("runPersonList: includes role/asiakas/limit when set", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [{ personId: 6233, name: "BetoniJerry System" }],
      nextCursor: null,
      count: 1,
    });
    const result = await runPersonList(mockClient, {
      role: "kuljettaja",
      asiakas: 1349,
      limit: 50,
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/person/list?role=kuljettaja&asiakas=1349&limit=50"
    );
    expect(result.count).toBe(1);
  });

  test("runPersonList: --owned appends ?owned=1", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runPersonList(mockClient, { owned: true });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/list?owned=1");
  });

  test.each([
    ["loggedInSince", "loggedInSince"],
    ["notLoggedInSince", "notLoggedInSince"],
  ])("runPersonList: %s converts Helsinki wall-clock to UTC", async (option, query) => {
    mockClient.get.mockResolvedValueOnce({ items: [{ personId: 1, lastLogin: null }], count: 1, nextCursor: null });
    const result = await runPersonList(mockClient, { [option]: "2026-10-15T18:30" });
    expect(mockClient.get).toHaveBeenCalledWith(`/api/cli/person/list?${query}=2026-10-15T15%3A30%3A00.000Z`);
    expect(result.items[0]).toHaveProperty("lastLogin", null);
  });

  test("runPersonList: explicit offset refers to the same instant", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], count: 0, nextCursor: null });
    await runPersonList(mockClient, { loggedInSince: "2026-10-15T18:30:00+03:00" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/list?loggedInSince=2026-10-15T15%3A30%3A00.000Z");
  });

  test.each(["loggedInSince", "notLoggedInSince"])("%s preserves fractional cutoff precision", async (option) => {
    mockClient.get.mockResolvedValueOnce({ items: [], count: 0, nextCursor: null });
    await runPersonList(mockClient, { [option]: "2026-10-15T18:30:00.999" });
    expect(mockClient.get).toHaveBeenCalledWith(`/api/cli/person/list?${option}=2026-10-15T15%3A30%3A00.999Z`);
  });

  test.each([
    { loggedInSince: "invalid" },
    { loggedInSince: "2026-02-30T12:00Z" },
    { loggedInSince: "2026-10-15T18:30", notLoggedInSince: "2026-10-15T18:30" },
  ])("runPersonList: rejects invalid/conflicting filters before the request (%j)", async (opts) => {
    await expect(runPersonList(mockClient, opts)).rejects.toMatchObject({ exitCode: 4 });
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("filtered reads reject a backend that ignored the filter", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [{ personId: 1 }], count: 1, nextCursor: null });
    await expect(runPersonList(mockClient, { loggedInSince: "2026-10-15T18:30" })).rejects.toThrow(/backend.*login activity/i);
  });

  test.each(["--logged-in-since", "--not-logged-in-since"])("registered %s flag reaches the API", async (flag) => {
    mockClient.get.mockResolvedValueOnce({ items: [], count: 0, nextCursor: null });
    const program = new Command("ib").exitOverride();
    registerPersonCommands(program, async () => mockClient, async () => mockClient);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["node", "ib", "person", "list", flag, "2026-10-15T18:30"]);
      expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining("2026-10-15T15%3A30%3A00.000Z"));
    } finally {
      out.mockRestore();
    }
  });

  test("registered conflicting flags emit exit 4 without a request", async () => {
    const program = new Command("ib").exitOverride();
    registerPersonCommands(program, async () => mockClient, async () => mockClient);
    const { exitCode, envelope } = await captureActionError(() => program.parseAsync(["node", "ib", "person", "list", "--logged-in-since", "2026-10-15", "--not-logged-in-since", "2026-10-16"]));
    expect(exitCode).toBe(4);
    expect(envelope.error).toMatch(/mutually exclusive/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("runPersonGet: GET /api/cli/person/get/6233", async () => {
    mockClient.get.mockResolvedValueOnce({
      personId: 6233,
      name: "BetoniJerry System",
    });
    const result = await runPersonGet(mockClient, 6233);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/get/6233");
    expect((result as { personId: number }).personId).toBe(6233);
  });

  /**
   * fb#620 — `ib person get 6300` returned "not found, verify personId" for a
   * person that exists, because the read is scoped to the active company and
   * there was no way to widen it. `ib vehicle get --asiakas` already had the
   * lever; this is the same shape on the person side.
   */
  test("runPersonGet: --asiakas widens the read to another tenant", async () => {
    mockClient.get.mockResolvedValueOnce({ personId: 6300 });
    await runPersonGet(mockClient, 6300, 1380);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/get/6300?asiakas=1380");
  });

  test("runPersonGet: no --asiakas leaves the path bare (active-company scope)", async () => {
    // The default must not start sending `?asiakas=` — a cross-tenant read is
    // uncached server-side, so an always-present param would quietly drop every
    // person get out of the cache.
    mockClient.get.mockResolvedValueOnce({ personId: 6233 });
    await runPersonGet(mockClient, 6233, undefined);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/get/6233");
  });

  test("runPersonSearch: POSTs /api/person/search with {searchString} body as a read", async () => {
    mockClient.post.mockResolvedValueOnce([
      { personId: 6233, name: "Jerry" },
    ]);
    await runPersonSearch(mockClient, "Jerry");
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/search",
      { searchString: "Jerry" },
      { read: true }
    );
  });

  test("runPersonSearch: forwards raw query untouched (no encoding)", async () => {
    mockClient.post.mockResolvedValueOnce([]);
    await runPersonSearch(mockClient, "Doe & Sons");
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/search",
      { searchString: "Doe & Sons" },
      { read: true }
    );
  });

  test("runPersonSearch forwards limit in the body", async () => {
    mockClient.post.mockResolvedValueOnce([]);
    await runPersonSearch(mockClient, "Matti", 10);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/search",
      { searchString: "Matti", limit: 10 },
      { read: true }
    );
  });

  // feedback #310: --asiakas <id> is the cross-tenant lever. The backend gates it
  // with canAccessOwnerAsiakas (any tenant for sysadmin/developer); omitting the
  // field is what keeps the DEFAULT scoped to the caller's active company.
  test("runPersonSearch sends ownerAsiakasId when --asiakas targets another tenant", async () => {
    mockClient.post.mockResolvedValueOnce([]);
    await runPersonSearch(mockClient, "Jerry", undefined, 1349);
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/person/search",
      { searchString: "Jerry", ownerAsiakasId: 1349 },
      { read: true }
    );
  });

  test("runPersonSearch omits ownerAsiakasId entirely when no --asiakas is given", async () => {
    mockClient.post.mockResolvedValueOnce([]);
    await runPersonSearch(mockClient, "Jerry", 5);
    const body = mockClient.post.mock.calls[0][1];
    expect(body).not.toHaveProperty("ownerAsiakasId");
  });

  test("runPersonSearch projects rows to a ListEnvelope with asiakasId from ownerAsiakasId", async () => {
    mockClient.post.mockResolvedValueOnce({
      recordset: [
        {
          personId: 100,
          personFirstName: "Mikko",
          personLastName: "Ikonen",
          personEmail: "mikko@x.fi",
          personPhone: "040",
          ownerAsiakasId: 8,
        },
      ],
    });
    const res = await runPersonSearch(mockClient, "Ikonen");
    expect(res).toEqual({
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
    });
  });
});
