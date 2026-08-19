import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runScheduleToday,
  runScheduleDay,
  runScheduleWeek,
} from "../../src/commands/schedule/index.js";
import { addDaysISO, todayHelsinki } from "../../src/dates.js";

/**
 * A JWT whose ownerAsiakasId claim is 8 — built as a real (unsigned) token
 * because `ownerAsiakasIdFromToken` DECODES it (mirrors test/commands/betoni.test.ts).
 */
function tokenFor(ownerAsiakasId: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ ownerAsiakasId })}.sig`;
}

const mockClient = mockApiClient({ getCurrentToken: vi.fn(() => tokenFor(8)) });

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

  // fb#777: schedule silently narrowed to the active company with no signal —
  // a 0-row result read as "none scheduled anywhere" rather than "none HERE".
  describe("scope echo (fb#777)", () => {
    test("runScheduleToday: names the queried tenant", async () => {
      mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
      const result = await runScheduleToday(mockClient);
      expect(result.scope).toEqual({ asiakasId: 8 });
    });

    test("runScheduleDay: names the queried tenant", async () => {
      mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
      const result = await runScheduleDay(mockClient, "2026-06-15");
      expect(result.scope).toEqual({ asiakasId: 8 });
    });

    test("runScheduleWeek: names the queried tenant", async () => {
      mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0 });
      const result = await runScheduleWeek(mockClient, "2026-06-01");
      expect(result.scope).toEqual({ asiakasId: 8 });
    });
  });
});

