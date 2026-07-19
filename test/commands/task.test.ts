import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  parseCadence,
  intFlag,
  runTaskList,
  runTaskGet,
  runTaskAdd,
  runTaskComplete,
  runTaskSet,
  runTaskLog,
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

  test.each(["monthly", "0/month", "1/year", "1-month", "", "121/month", "9999/day"])(
    "rejects %j with exit 4",
    (v) => {
      expect(() => parseCadence(v)).toThrowError(/--cadence/);
    }
  );

  test("accepts the 120 cap boundary", () => {
    expect(parseCadence("120/month")).toEqual({ cadenceCount: 120, cadenceUnit: "month" });
  });
});

describe("intFlag", () => {
  test("parses integers at or above min", () => {
    expect(intFlag("--assignee")("10")).toBe(10);
    expect(intFlag("--offset", 0)("0")).toBe(0);
  });

  test.each(["abc", "12abc", "1.5", "-1", "0"])("rejects %j with exit 4 (no NaN passthrough)", (v) => {
    expect(() => intFlag("--assignee")(v)).toThrowError(/--assignee must be an integer/);
  });
});

describe("runTaskList", () => {
  test("builds the filter query string with a probe limit", async () => {
    await runTaskList(client, { due: true, executor: "ai", agent: "claude", assignee: 10, asiakas: 8, inactive: true });
    expect(client.get).toHaveBeenCalledWith(
      "/api/tasks?due=1&executor=ai&agent=claude&assignee=10&asiakas=8&includeInactive=1&limit=51"
    );
  });

  test("returns the list envelope", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ taskId: 1 }]);
    const env = await runTaskList(client, {});
    expect(env).toEqual({ items: [{ taskId: 1 }], nextCursor: null, count: 1 });
  });

  test("exactly --limit rows is NOT truncated (probe row absent)", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ taskId: 1 }, { taskId: 2 }]);
    const env = await runTaskList(client, { limit: 2 });
    expect(client.get).toHaveBeenCalledWith("/api/tasks?limit=3");
    expect(env.truncated).toBeUndefined();
    expect(env.count).toBe(2);
  });

  test("probe row present → truncated and sliced to --limit", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ taskId: 1 }, { taskId: 2 }, { taskId: 3 }]);
    const env = await runTaskList(client, { limit: 2 });
    expect(env.truncated).toBe(true);
    expect(env.items).toEqual([{ taskId: 1 }, { taskId: 2 }]);
    expect(env.count).toBe(2);
  });

  test("--limit past the server cap clamps to 200 and flags a full page", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ taskId: i + 1 }));
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    const env = await runTaskList(client, { limit: 500 });
    expect(client.get).toHaveBeenCalledWith("/api/tasks?limit=200");
    expect(env.truncated).toBe(true);
    expect(env.count).toBe(200);
  });

  test("unknown executor exits 4 before any fetch", async () => {
    await expect(runTaskList(client, { executor: "robot" })).rejects.toThrowError(/--executor/);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("runTaskGet", () => {
  test("fetches one task by id", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: 7, title: "t" });
    const row = await runTaskGet(client, 7);
    expect(client.get).toHaveBeenCalledWith("/api/tasks/7");
    expect(row).toEqual({ taskId: 7, title: "t" });
  });
});

describe("runTaskLog", () => {
  test("fetches with a probe limit and returns the envelope", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ logId: 1 }]);
    const env = await runTaskLog(client, 7, {});
    expect(client.get).toHaveBeenCalledWith("/api/tasks/7/log?limit=51");
    expect(env).toEqual({ items: [{ logId: 1 }], nextCursor: null, count: 1 });
  });

  test("probe row present → truncated and sliced to --limit", async () => {
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue([{ logId: 1 }, { logId: 2 }]);
    const env = await runTaskLog(client, 7, { limit: 1 });
    expect(client.get).toHaveBeenCalledWith("/api/tasks/7/log?limit=2");
    expect(env.truncated).toBe(true);
    expect(env.items).toEqual([{ logId: 1 }]);
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
