import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runPersonAppSeen } from "../../src/commands/person/appSeen.js";

const c = mockApiClient();
const LIST = { items: [], nextCursor: null, count: 0 };

describe("ib person app-seen", () => {
  beforeEach(() => vi.clearAllMocks());

  test("calls /api/cli/driver/app-seen with the ISO date", async () => {
    c.get.mockResolvedValueOnce(LIST);
    await runPersonAppSeen(c, { date: "2026-09-24" });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/app-seen?date=2026-09-24");
  });

  test("passes the backend envelope through", async () => {
    const env = { items: [{ personId: 372, name: "Jerker N", date: "2026-09-24", opens: 2 }], nextCursor: null, count: 1 };
    c.get.mockResolvedValueOnce(env);
    await expect(runPersonAppSeen(c, { date: "2026-09-24" })).resolves.toEqual(env);
  });
});
