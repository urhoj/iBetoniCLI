import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  parseCadence,
  runTaskList,
  runTaskAdd,
  runTaskComplete,
  runTaskSet,
} from "../../src/commands/task/index.js";
import type { ApiClient } from "../../src/api/client.js";

function mockClient(): ApiClient {
  return {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({ taskId: 7 }),
    put: vi.fn().mockResolvedValue({ taskId: 7 }),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
}

let client: ApiClient;
beforeEach(() => {
  client = mockClient();
});

describe("parseCadence", () => {
  test("parses count/unit", () => {
    expect(parseCadence("1/month")).toEqual({ cadenceCount: 1, cadenceUnit: "month" });
    expect(parseCadence("2/week")).toEqual({ cadenceCount: 2, cadenceUnit: "week" });
  });

  test.each(["monthly", "0/month", "1/year", "1-month", ""])("rejects %j with exit 4", (v) => {
    expect(() => parseCadence(v)).toThrowError(/--cadence/);
  });
});

describe("runTaskList", () => {
  test("builds the filter query string", async () => {
    await runTaskList(client, { due: true, executor: "ai", agent: "claude", assignee: 10, asiakas: 8, inactive: true });
    expect(client.get).toHaveBeenCalledWith(
      "/api/tasks?due=1&executor=ai&agent=claude&assignee=10&asiakas=8&includeInactive=1"
    );
  });

  test("returns the list envelope", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ taskId: 1 }]);
    const env = await runTaskList(client, {});
    expect(env).toEqual({ items: [{ taskId: 1 }], nextCursor: null, count: 1 });
  });

  test("unknown executor exits 4 before any fetch", async () => {
    await expect(runTaskList(client, { executor: "robot" })).rejects.toThrowError(/--executor/);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("runTaskAdd", () => {
  test("posts the create body with write-flag headers", async () => {
    await runTaskAdd(
      client,
      { title: "Monthly check", executor: "ai", agent: "claude", skill: "cleanup-docs", cadence: "1/month", asiakas: 8 },
      { reason: "seed" }
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/tasks",
      {
        title: "Monthly check",
        executor: "ai",
        cadenceUnit: "month",
        cadenceCount: 1,
        recommendedAgent: "claude",
        skillRef: "cleanup-docs",
        asiakasId: 8,
      },
      { headers: { "X-Action-Reason": "seed" } }
    );
  });

  test.each([
    [{ executor: "ai", cadence: "1/month" }, /--title/],
    [{ title: "x", cadence: "1/month" }, /--executor/],
    [{ title: "x", executor: "ai" }, /--cadence/],
    [{ title: "x", executor: "ai", cadence: "1/month", agent: "gpt" }, /--agent/],
  ])("invalid input %# exits 4", async (input, msg) => {
    await expect(
      runTaskAdd(client, input as Parameters<typeof runTaskAdd>[1], {})
    ).rejects.toThrowError(msg);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("runTaskComplete", () => {
  test("default outcome is done", async () => {
    await runTaskComplete(client, 7, {}, {});
    expect(client.post).toHaveBeenCalledWith("/api/tasks/7/complete", { outcome: "done" }, { headers: {} });
  });

  test("--failed maps to outcome failed with notes + agent", async () => {
    await runTaskComplete(client, 7, { failed: true, agent: "claude", notes: "boom" }, {});
    expect(client.post).toHaveBeenCalledWith(
      "/api/tasks/7/complete",
      { outcome: "failed", agent: "claude", notes: "boom" },
      { headers: {} }
    );
  });

  test("--skipped and --failed are mutually exclusive", async () => {
    await expect(runTaskComplete(client, 7, { skipped: true, failed: true }, {})).rejects.toThrowError(
      /mutually exclusive/
    );
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("runTaskSet", () => {
  test("no fields exits 4", async () => {
    await expect(runTaskSet(client, 7, {}, {})).rejects.toThrowError(/at least one/);
    expect(client.put).not.toHaveBeenCalled();
  });

  test("--deactivate maps to active:false; --cadence re-parses", async () => {
    await runTaskSet(client, 7, { deactivate: true, cadence: "2/week" }, {});
    expect(client.put).toHaveBeenCalledWith(
      "/api/tasks/7",
      { active: false, cadenceUnit: "week", cadenceCount: 2 },
      { headers: {} }
    );
  });

  test("empty-string --skill clears skillRef", async () => {
    await runTaskSet(client, 7, { skill: "" }, {});
    expect(client.put).toHaveBeenCalledWith("/api/tasks/7", { skillRef: null }, { headers: {} });
  });

  test("--activate and --deactivate are mutually exclusive", async () => {
    await expect(runTaskSet(client, 7, { activate: true, deactivate: true }, {})).rejects.toThrowError(
      /mutually exclusive/
    );
  });
});
