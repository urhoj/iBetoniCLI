import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runBugCreate,
  runBugList,
  runBugGet,
  runBugComment,
  runBugAdminUpdate,
} from "../../src/commands/bug/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const post = mockClient.post as ReturnType<typeof vi.fn>;
const get = mockClient.get as ReturnType<typeof vi.fn>;
const put = mockClient.put as ReturnType<typeof vi.fn>;
const del = mockClient.delete as ReturnType<typeof vi.fn>;

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  put.mockReset();
  del.mockReset();
});

describe("ib bug create", () => {
  test("POSTs /api/bugs/report and returns bugReportId + referenceNumber", async () => {
    post.mockResolvedValueOnce({ success: true, bugReportId: 51, referenceNumber: "BR-51" });
    const out = await runBugCreate(mockClient, {
      type: "functionality-error",
      severity: "major",
      description: "  Grid crashes on save  ",
      steps: "open grid, click save",
    });
    expect(post).toHaveBeenCalledWith(
      "/api/bugs/report",
      {
        bugType: "functionality-error",
        severity: "major",
        description: "Grid crashes on save",
        stepsToReproduce: "open grid, click save",
      },
      { headers: {} }
    );
    expect(out).toEqual({ bugReportId: 51, referenceNumber: "BR-51" });
  });

  test("forwards --priority and --reason (X-Action-Reason header)", async () => {
    post.mockResolvedValueOnce({ bugReportId: 52, referenceNumber: "BR-52" });
    await runBugCreate(mockClient, {
      type: "other",
      severity: "minor",
      description: "x",
      priority: "high",
      reason: "filed by agent",
    });
    expect(post).toHaveBeenCalledWith(
      "/api/bugs/report",
      { bugType: "other", severity: "minor", description: "x", priority: "high" },
      { headers: { "X-Action-Reason": "filed by agent" } }
    );
  });

  test("--dry-run prints the payload and never POSTs", async () => {
    const out = await runBugCreate(mockClient, {
      type: "other",
      severity: "cosmetic",
      description: "preview",
      dryRun: true,
    });
    expect(post).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: {
        method: "POST",
        path: "/api/bugs/report",
        body: { bugType: "other", severity: "cosmetic", description: "preview" },
      },
    });
  });

  test("empty description → exit 4, no POST", async () => {
    await expect(
      runBugCreate(mockClient, { type: "other", severity: "minor", description: "   " })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  test("bad --type → exit 4, no POST", async () => {
    await expect(
      runBugCreate(mockClient, { type: "nonsense", severity: "minor", description: "x" })
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  test("bad --severity → exit 4", async () => {
    await expect(
      runBugCreate(mockClient, { type: "other", severity: "huge", description: "x" })
    ).rejects.toThrowError(CliError);
  });

  test("bad --priority → exit 4", async () => {
    await expect(
      runBugCreate(mockClient, { type: "other", severity: "minor", description: "x", priority: "p0" })
    ).rejects.toThrowError(CliError);
  });
});

describe("ib bug list", () => {
  test("maps filters to the querystring and projects { success, data } into the envelope", async () => {
    get.mockResolvedValueOnce({ success: true, data: [{ bugReportId: 1 }, { bugReportId: 2 }] });
    const out = await runBugList(mockClient, {
      status: "new",
      severity: "major",
      type: "functionality-error",
      owner: 1349,
      limit: 20,
      offset: 0,
      orderBy: "severity",
      order: "asc",
    });
    expect(get).toHaveBeenCalledWith(
      "/api/bugs/list?status=new&severity=major&bugType=functionality-error&ownerAsiakasId=1349&limit=20&offset=0&orderBy=severity&orderDirection=asc"
    );
    expect(out).toEqual({
      items: [{ bugReportId: 1 }, { bugReportId: 2 }],
      nextCursor: null,
      count: 2,
      truncated: false,
    });
  });

  test("no filters → bare path; null data tolerated", async () => {
    get.mockResolvedValueOnce(null);
    const out = await runBugList(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/bugs/list");
    expect(out).toEqual({ items: [], nextCursor: null, count: 0, truncated: false });
  });

  test("sets truncated when rows hit the limit", async () => {
    get.mockResolvedValueOnce({ data: [{ bugReportId: 1 }, { bugReportId: 2 }] });
    const out = await runBugList(mockClient, { limit: 2 });
    expect(out).toMatchObject({ count: 2, truncated: true });
  });

  test("bad --status → exit 4, no GET", async () => {
    await expect(runBugList(mockClient, { status: "bogus" })).rejects.toMatchObject({ exitCode: 4 });
    expect(get).not.toHaveBeenCalled();
  });

  test("bad --order-by → exit 4", async () => {
    await expect(runBugList(mockClient, { orderBy: "hacker" })).rejects.toThrowError(CliError);
  });
});

describe("ib bug get", () => {
  test("GETs /api/bugs/:id and unwraps .data (report + comments + attachments)", async () => {
    get.mockResolvedValueOnce({
      success: true,
      data: { bugReportId: 51, comments: [], attachments: [] },
    });
    const out = await runBugGet(mockClient, 51);
    expect(get).toHaveBeenCalledWith("/api/bugs/51");
    expect(out).toEqual({ bugReportId: 51, comments: [], attachments: [] });
  });
});

describe("ib bug comment", () => {
  test("POSTs the trimmed comment and returns commentId", async () => {
    post.mockResolvedValueOnce({ success: true, commentId: 9 });
    const out = await runBugComment(mockClient, 51, { body: "  please retest  ", reason: "triage" });
    expect(post).toHaveBeenCalledWith(
      "/api/bugs/51/comment",
      { comment: "please retest" },
      { headers: { "X-Action-Reason": "triage" } }
    );
    expect(out).toEqual({ commentId: 9 });
  });

  test("--dry-run previews and never POSTs", async () => {
    const out = await runBugComment(mockClient, 51, { body: "later", dryRun: true });
    expect(post).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: { method: "POST", path: "/api/bugs/51/comment", body: { comment: "later" } },
    });
  });

  test("empty --body → exit 4, no POST", async () => {
    await expect(runBugComment(mockClient, 51, { body: "  " })).rejects.toMatchObject({ exitCode: 4 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("ib bug admin update", () => {
  test("PUTs only the provided fields (notes→adminNotes, assign→assignedTo) and unwraps .data", async () => {
    put.mockResolvedValueOnce({ success: true, data: { bugReportId: 51, status: "resolved" } });
    const out = await runBugAdminUpdate(mockClient, 51, {
      status: "resolved",
      priority: "high",
      notes: "fixed in v2",
      resolution: "patched grid save",
      assign: 6233,
      reason: "triage",
    });
    expect(put).toHaveBeenCalledWith(
      "/api/bugs/admin/51",
      {
        status: "resolved",
        priority: "high",
        adminNotes: "fixed in v2",
        resolution: "patched grid save",
        assignedTo: 6233,
      },
      { headers: { "X-Action-Reason": "triage" } }
    );
    expect(out).toEqual({ bugReportId: 51, status: "resolved" });
  });

  test("--dry-run previews and never PUTs", async () => {
    const out = await runBugAdminUpdate(mockClient, 51, { status: "closed", dryRun: true });
    expect(put).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      wouldSend: { method: "PUT", path: "/api/bugs/admin/51", body: { status: "closed" } },
    });
  });

  test("no fields provided → exit 4, no PUT", async () => {
    await expect(runBugAdminUpdate(mockClient, 51, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(put).not.toHaveBeenCalled();
  });

  test("bad --status → exit 4", async () => {
    await expect(runBugAdminUpdate(mockClient, 51, { status: "done" })).rejects.toThrowError(CliError);
  });

  test("bad --priority → exit 4", async () => {
    await expect(runBugAdminUpdate(mockClient, 51, { priority: "p1" })).rejects.toThrowError(CliError);
  });
});
