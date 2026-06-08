import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runScheduleDay,
  runScheduleWeek,
} from "../../src/commands/schedule/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib schedule date resolution", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(path).not.toContain("tomorrow");
    expect(path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });

  test("runScheduleWeek resolves 'today' and spans 7 days", async () => {
    await runScheduleWeek(mockClient, "today");
    const path = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(path).not.toContain("today");
    expect(path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });
});
