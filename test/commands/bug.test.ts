import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runBugCreate,
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
