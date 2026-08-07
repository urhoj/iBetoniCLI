import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runScheduleToday,
  runScheduleDay,
  runScheduleWeek,
} from "../../src/commands/schedule/index.js";
import { addDaysISO, todayHelsinki } from "../../src/dates.js";

const mockClient = mockApiClient();

describe("ib schedule today/day/week", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("runScheduleToday: calls runKeikkaList with today/today", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runScheduleToday(mockClient);
    const today = todayHelsinki();
    expect(mockClient.get).toHaveBeenCalledWith(
      `/api/cli/keikka/list?from=${today}&to=${today}`
    );
  });

  test("runScheduleDay: calls runKeikkaList with date/date", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runScheduleDay(mockClient, "2026-06-15");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/keikka/list?from=2026-06-15&to=2026-06-15"
    );
  });

  test("runScheduleWeek: calls runKeikkaList with start..start+6", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runScheduleWeek(mockClient, "2026-06-01");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/keikka/list?from=2026-06-01&to=2026-06-07"
    );
  });

  test("addDaysISO: handles month boundary", () => {
    expect(addDaysISO("2026-06-28", 6)).toBe("2026-07-04");
  });
});
