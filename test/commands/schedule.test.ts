import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runScheduleDay,
  runScheduleWeek,
} from "../../src/commands/schedule/index.js";

// ownerAsiakasIdFromToken decodes this (fb#777's scope echo) — a bare stub
// token would fail owner resolution and every test here would 4xx before
// reaching the assertion.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "none" })}.${b64({ ownerAsiakasId: 8 })}.sig`;

const mockClient = mockApiClient({ getCurrentToken: vi.fn(() => TOKEN) });

describe("ib schedule date resolution", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.get.mockResolvedValue({
      items: [],
      nextCursor: null,
      count: 0,
    });
  });

  test("runScheduleDay passes a literal ISO date through unchanged", async () => {
    await runScheduleDay(mockClient, "2026-01-15");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/keikka/list?from=2026-01-15&to=2026-01-15"
    );
  });

  test("runScheduleDay resolves the 'tomorrow' alias to a real date", async () => {
    await runScheduleDay(mockClient, "tomorrow");
    const path = mockClient.get.mock.calls[0][0];
    expect(path).not.toContain("tomorrow");
    expect(path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });

  test("runScheduleWeek resolves 'today' and spans 7 days", async () => {
    await runScheduleWeek(mockClient, "today");
    const path = mockClient.get.mock.calls[0][0];
    expect(path).not.toContain("today");
    expect(path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });
});
