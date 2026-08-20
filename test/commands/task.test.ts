import { describe, test, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import {
  parseCadence,
  intFlag,
  runTaskList,
  runTaskGet,
  runTaskAdd,
  runTaskComplete,
  runTaskSet,
  runTaskLog,
  registerTaskCommands,
} from "../../src/commands/task/index.js";
import { payloadKeyMap } from "../../src/commands/_shared/fromJson.js";
import { captureActionError } from "../helpers/stderr.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockClient(): MockApiClient {
  return mockApiClient({
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({ taskId: 7 }),
    put: vi.fn().mockResolvedValue({ taskId: 7 }),
  });
}

let client: MockApiClient;
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
    client.get.mockResolvedValue([{ taskId: 1 }]);
    const env = await runTaskList(client, {});
    expect(env).toEqual({ items: [{ taskId: 1 }], nextCursor: null, count: 1 });
  });

  test("exactly --limit rows is NOT truncated (probe row absent)", async () => {
    client.get.mockResolvedValue([{ taskId: 1 }, { taskId: 2 }]);
    const env = await runTaskList(client, { limit: 2 });
    expect(client.get).toHaveBeenCalledWith("/api/tasks?limit=3");
    expect(env.truncated).toBeUndefined();
    expect(env.count).toBe(2);
  });

  test("probe row present → truncated and sliced to --limit", async () => {
    client.get.mockResolvedValue([{ taskId: 1 }, { taskId: 2 }, { taskId: 3 }]);
    const env = await runTaskList(client, { limit: 2 });
    expect(env.truncated).toBe(true);
    expect(env.items).toEqual([{ taskId: 1 }, { taskId: 2 }]);
    expect(env.count).toBe(2);
  });

  test("--limit past the server cap clamps to 200 and flags a full page", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ taskId: i + 1 }));
    client.get.mockResolvedValue(rows);
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
    client.get.mockResolvedValue({ taskId: 7, title: "t" });
    const row = await runTaskGet(client, 7);
    expect(client.get).toHaveBeenCalledWith("/api/tasks/7");
    expect(row).toEqual({ taskId: 7, title: "t" });
  });
});

describe("runTaskLog", () => {
  test("fetches with a probe limit and returns the envelope", async () => {
    client.get.mockResolvedValue([{ logId: 1 }]);
    const env = await runTaskLog(client, 7, {});
    expect(client.get).toHaveBeenCalledWith("/api/tasks/7/log?limit=51");
    expect(env).toEqual({ items: [{ logId: 1 }], nextCursor: null, count: 1 });
  });

  test("probe row present → truncated and sliced to --limit", async () => {
    client.get.mockResolvedValue([{ logId: 1 }, { logId: 2 }]);
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

// fb#534 — every task was recurring, so a genuine single-shot reminder had to be
// dressed up as --cadence 120/month (~10 years) so completion rolled nextDueAt to
// 2036 instead of nagging monthly. It worked, and read as a mistake.
describe("runTaskAdd --once (fb#534)", () => {
  test("sends cadenceUnit 'once' and NO cadenceCount", async () => {
    await runTaskAdd(
      client,
      { title: "Activate Hyvinkaan Betoni", executor: "human", once: true, firstDue: "2026-11-02" },
      { reason: "one-time activation" }
    );
    const body = client.post.mock.calls[0][1];
    expect(body).toMatchObject({ cadenceUnit: "once", firstDueAt: "2026-11-02" });
    // Inventing a count here would put a meaningless number on the wire — the
    // 120/month problem in miniature. The backend normalizes the NOT NULL column.
    expect(body).not.toHaveProperty("cadenceCount");
  });

  test("--once with --cadence exits 4 — a one-off has no interval", async () => {
    await expect(
      runTaskAdd(client, { title: "x", executor: "human", once: true, cadence: "1/month" }, {})
    ).rejects.toThrowError(/mutually exclusive/);
    expect(client.post).not.toHaveBeenCalled();
  });

  test("neither --once nor --cadence still exits 4, now naming both ways out", async () => {
    await expect(
      runTaskAdd(client, { title: "x", executor: "human" }, {})
    ).rejects.toThrowError(/--once/);
  });

  test("--once is registered on argv, so it can ride alongside --from-json", () => {
    // Deliberately NOT a --from-json key (fb#541 class): a valueless boolean
    // advertised as a JSON key cannot work — `true` exits 4 and `"true"` is
    // silently dropped, yielding a RECURRING task the caller believes is
    // one-off. The end-to-end rejection is asserted in the --from-json block.
    const program = new Command();
    registerTaskCommands(program, async () => client as never);
    const add = program.commands
      .find((c) => c.name() === "task")!
      .commands.find((c) => c.name() === "add")!;
    expect(add.options.some((o) => o.long === "--once")).toBe(true);
  });
});

describe("runTaskSet --once (fb#534 conversion path)", () => {
  test("converts an existing task, leaving the meaningless cadenceCount alone", async () => {
    await runTaskSet(client, 5, { once: true }, { reason: "was faking once as 120/month" });
    const body = client.put.mock.calls[0][1];
    expect(body).toEqual({ cadenceUnit: "once" });
    expect(body).not.toHaveProperty("cadenceCount");
  });

  test("--once with --cadence exits 4 here too", async () => {
    await expect(
      runTaskSet(client, 5, { once: true, cadence: "1/month" }, {})
    ).rejects.toThrowError(/mutually exclusive/);
    expect(client.put).not.toHaveBeenCalled();
  });
});

// fb#450: --from-json parity for the command whose --instructions is exactly
// the long quote-bearing prose the JSON path exists to protect.
describe("task add --from-json wiring (fb#450)", () => {
  const addCmd = () => {
    const program = new Command();
    registerTaskCommands(program, async () => client as never);
    return program.commands
      .find((c) => c.name() === "task")!
      .commands.find((c) => c.name() === "add")!;
  };

  test("--from-json is wired and --title is no longer Commander-mandatory", () => {
    const add = addCmd();
    expect(add.options.some((o) => o.long === "--from-json")).toBe(true);
    // A Commander-mandatory --title would (a) reject a JSON-supplied title and
    // (b) mask an unknown flag behind "missing --title" (the fb#309 ordering).
    const title = add.options.find((o) => o.long === "--title")!;
    expect(title.mandatory).toBe(false);
  });

  test("the payload key map covers every task field and no write-safety flag", () => {
    const keys = payloadKeyMap(addCmd(), {
      nonPayload: new Set(["fromJson", "dryRun", "idempotencyKey", "reason", "help"]),
    });
    for (const k of ["title", "executor", "instructions", "skill", "agent", "assignee", "asiakas", "cadence", "feedback"]) {
      expect(keys.get(k), k).toBe(k);
    }
    // Both spellings of the hyphenated flag resolve to the camelCase attribute.
    expect(keys.get("firstDue")).toBe("firstDue");
    expect(keys.get("first-due")).toBe("firstDue");
    for (const k of ["fromJson", "dryRun", "idempotencyKey", "reason", "help"]) {
      expect(keys.has(k), k).toBe(false);
    }
  });

  // fb#534 + fb#541: `once` is a VALUELESS boolean, so as a JSON key it can only
  // fail — `true` exits 4 ("must be a string") and `"true"` is accepted and
  // silently dropped, producing a recurring task the caller believes is one-off.
  // It is excluded from the accepted keys so it is loudly rejected as unknown.
  test("a --from-json payload naming `once` exits 4 as an unknown key, never silently dropped", async () => {
    const file = join(tmpdir(), `ib-task-once-${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ title: "x", executor: "human", once: true }), "utf8");
    try {
      const { exitCode, envelope } = await captureActionError(async () => {
        const program = new Command();
        registerTaskCommands(program, async () => client as never);
        await program.parseAsync(["task", "add", "--from-json", file, "--reason", "r"], { from: "user" });
      });

      expect(exitCode).toBe(4);
      expect((envelope as { error: string }).error).toMatch(/unknown key once/);
      // The accepted-key list must NOT advertise it — that is the whole point.
      expect((envelope as { error: string }).error).not.toMatch(/accepted:.*\bonce\b/);
      expect(client.post).not.toHaveBeenCalled();
    } finally {
      unlinkSync(file);
    }
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
